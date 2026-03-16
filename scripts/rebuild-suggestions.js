#!/usr/bin/env node
/**
 * Incremental AI product match suggestions using Claude Batch API.
 *
 * - Skirts: all active, published online, not finalsale, stock > 2
 * - Tops: only from the "aimatchingtops" Shopify collection
 * - Incremental: only processes skirts not already in suggestions.json
 * - Cleanup: removes suggestions for skirts that are no longer active/available
 * - Uses Anthropic Message Batches API (50% cheaper, no rate limits)
 *
 * Flags:
 *   --full        Force full rebuild (re-process all skirts)
 *   --test        Test mode (process max 1 batch, output to suggestions-test.json)
 *   --collection  Override skirt source with a specific collection handle
 *
 * Required env vars:
 *   SHOPIFY_ACCESS_TOKEN
 *   ANTHROPIC_API_KEY
 */

const fs = require('fs');
const path = require('path');

// ----- Config -----
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'yakirabella.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const API_VERSION = '2025-10';
const TOPS_COLLECTION = 'aimatchingtops';
const BATCH_SIZE = 10;

const TEST_MODE = process.argv.includes('--test');
const FULL_REBUILD = process.argv.includes('--full');
const COLLECTION_FLAG_IDX = process.argv.indexOf('--collection');
const TEST_COLLECTION = COLLECTION_FLAG_IDX !== -1 ? process.argv[COLLECTION_FLAG_IDX + 1] : null;

if (!SHOPIFY_TOKEN) { console.error('Missing SHOPIFY_ACCESS_TOKEN'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ----- Shopify GraphQL helper -----
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Shopify API error ${res.status}: ${JSON.stringify(json)}`);
  }

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }

  return json;
}

// ----- Anthropic Batch API helpers -----
async function createBatch(requests) {
  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ requests })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Batch API create error ${res.status}: ${err}`);
  }
  return res.json();
}

async function pollBatch(batchId) {
  while (true) {
    const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Batch API poll error ${res.status}: ${err}`);
    }

    const batch = await res.json();
    const counts = batch.request_counts;
    const done = counts.succeeded + counts.errored + counts.canceled + counts.expired;
    const total = done + counts.processing;
    console.log(`  Batch status: ${batch.processing_status} (${counts.succeeded} succeeded, ${counts.errored} errored, ${counts.processing} processing of ${total})`);

    if (batch.processing_status === 'ended') {
      return batch;
    }

    // Poll every 30 seconds
    await new Promise(r => setTimeout(r, 30000));
  }
}

async function getBatchResults(batchId) {
  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    }
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Batch API results error ${res.status}: ${err}`);
  }

  // Results come as JSONL
  const text = await res.text();
  return text.trim().split('\n').map(line => JSON.parse(line));
}

// ----- Fetch all products of a given type (paginated) -----
const FETCH_PRODUCTS_QUERY = `
  query fetchProducts($query: String!, $cursor: String) {
    products(first: 50, query: $query, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          productType
          tags
          status
          images(first: 1) { edges { node { url } } }
          variants(first: 50) {
            edges {
              node {
                price
                inventoryItem {
                  inventoryLevels(first: 20) {
                    edges {
                      node {
                        quantities(names: ["available"]) { name quantity }
                      }
                    }
                  }
                }
              }
            }
          }
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          upsellMeta: metafield(namespace: "theme", key: "upsell_list") {
            type
            value
            references(first: 30) {
              nodes {
                ... on Product { id title handle }
              }
            }
          }
        }
      }
    }
  }
`;

function parseProduct(p) {
  const totalInventory = p.variants.edges.reduce((sum, v) => {
    const levels = v.node.inventoryItem?.inventoryLevels?.edges || [];
    return sum + levels.reduce((lSum, lvl) => {
      const qty = lvl.node.quantities?.find(q => q.name === 'available')?.quantity || 0;
      return lSum + qty;
    }, 0);
  }, 0);

  const metafields = {};
  for (const mfEdge of (p.metafields?.edges || [])) {
    const mf = mfEdge.node;
    metafields[`${mf.namespace}.${mf.key}`] = mf.value;
  }

  const curatedMatches = [];
  const upsellMeta = p.upsellMeta;
  if (upsellMeta) {
    const refs = upsellMeta.references?.nodes || [];
    if (refs.length) {
      refs.forEach(r => curatedMatches.push({ id: r.id, title: r.title, handle: r.handle }));
    } else if (upsellMeta.value) {
      const tokens = upsellMeta.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      tokens.forEach(t => curatedMatches.push({ handle: t, title: t }));
    }
  }

  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    productType: p.productType,
    tags: p.tags,
    image: p.images?.edges?.[0]?.node?.url || null,
    price: p.variants.edges[0]?.node?.price || null,
    totalInventory,
    color: metafields['theme.color'] || metafields['custom.color'] || '',
    material: metafields['theme.material'] || metafields['custom.material'] || '',
    season: metafields['theme.season'] || metafields['custom.season'] || '',
    curatedMatches
  };
}

async function fetchAllProducts(productType) {
  const allProducts = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    console.log(`  Fetching ${productType} page ${page}...`);
    const result = await shopifyGraphQL(FETCH_PRODUCTS_QUERY, {
      query: `product_type:'${productType}' AND status:active AND published_status:published`,
      cursor
    });

    const data = result.data?.products;
    if (!data) break;

    for (const edge of data.edges) {
      allProducts.push(parseProduct(edge.node));
    }

    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }

  return allProducts;
}

// ----- Fetch products from a specific collection -----
async function fetchCollectionProducts(handle) {
  console.log(`  Fetching collection: ${handle}...`);

  const COLLECTION_IDS_QUERY = `
    query getCollectionProducts($handle: String!, $cursor: String) {
      collectionByHandle(handle: $handle) {
        id
        title
        handle
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node { id title status }
          }
        }
      }
    }
  `;

  const PRODUCT_DETAIL_QUERY = `
    query getProduct($id: ID!) {
      product(id: $id) {
        id title handle productType tags status
        images(first: 1) { edges { node { url } } }
        variants(first: 50) {
          edges {
            node {
              price
              inventoryItem {
                inventoryLevels(first: 20) {
                  edges {
                    node {
                      quantities(names: ["available"]) { name quantity }
                    }
                  }
                }
              }
            }
          }
        }
        metafields(first: 10) {
          edges { node { namespace key value } }
        }
        upsellMeta: metafield(namespace: "theme", key: "upsell_list") {
          type value
          references(first: 30) {
            nodes { ... on Product { id title handle } }
          }
        }
      }
    }
  `;

  const productIds = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const result = await shopifyGraphQL(COLLECTION_IDS_QUERY, { handle, cursor });

    const collection = result.data?.collectionByHandle;
    if (!collection) {
      console.error(`  Collection "${handle}" not found.`);
      return [];
    }

    if (page === 1) {
      console.log(`  Found collection: "${collection.title}" (handle: ${collection.handle})`);
    }

    const conn = collection.products;
    const edges = conn?.edges || [];
    console.log(`  Collection page ${page}: ${edges.length} products`);

    for (const edge of edges) {
      if (edge.node.status === 'ACTIVE') {
        productIds.push(edge.node.id);
      }
    }

    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  console.log(`  ${productIds.length} active products to fetch details for...`);

  const products = [];
  for (const id of productIds) {
    const result = await shopifyGraphQL(PRODUCT_DETAIL_QUERY, { id });
    const p = result.data?.product;
    if (!p) continue;
    products.push(parseProduct(p));
  }

  return products;
}

// ----- Build product catalog summary for Claude -----
function buildProductSummary(product) {
  const parts = [`[${product.id}] ${product.title}`];
  if (product.productType) parts.push(`Type: ${product.productType}`);
  if (product.color) parts.push(`Color: ${product.color}`);
  if (product.material) parts.push(`Material: ${product.material}`);
  if (product.season) parts.push(`Season: ${product.season}`);
  if (product.tags?.length) parts.push(`Tags: ${product.tags.join(', ')}`);
  if (product.price) parts.push(`Price: $${product.price}`);
  parts.push(`Stock: ${product.totalInventory}`);
  return parts.join(' | ');
}

// ----- Main -----
async function main() {
  const mode = TEST_MODE ? 'TEST' : FULL_REBUILD ? 'FULL REBUILD' : 'INCREMENTAL';
  console.log(`Starting suggestion rebuild (${mode})...\n`);

  // 1. Fetch tops from aimatchingtops collection
  console.log('Fetching tops from aimatchingtops collection...');
  const allTops = await fetchCollectionProducts(TOPS_COLLECTION);
  // Filter: stock > 2, not finalsale
  const tops = allTops.filter(p => {
    if (p.totalInventory <= 2) return false;
    if ((p.tags || []).some(t => t.toLowerCase() === 'finalsale')) return false;
    return true;
  });
  console.log(`  ${allTops.length} total → ${tops.length} after filtering (stock > 2, no finalsale)\n`);

  if (tops.length === 0) {
    throw new Error('No tops available after filtering. Check the aimatchingtops collection.');
  }

  // 2. Fetch skirts
  let allSkirts;
  if (TEST_MODE && TEST_COLLECTION) {
    console.log(`Fetching skirts from test collection: ${TEST_COLLECTION}...`);
    allSkirts = await fetchCollectionProducts(TEST_COLLECTION);
    if (allSkirts.length === 0) {
      throw new Error(`Test collection "${TEST_COLLECTION}" returned 0 products.`);
    }
  } else {
    console.log('Fetching skirts (active, published, not finalsale)...');
    allSkirts = await fetchAllProducts('Skirt');
  }

  // Filter skirts: stock > 2, not finalsale
  const skirts = allSkirts.filter(p => {
    if (p.totalInventory <= 2) return false;
    if ((p.tags || []).some(t => t.toLowerCase() === 'finalsale')) return false;
    return true;
  });
  console.log(`  ${allSkirts.length} total → ${skirts.length} after filtering\n`);

  // 3. Load existing suggestions for incremental mode
  const outputFile = TEST_MODE ? 'suggestions-test.json' : 'suggestions.json';
  const outputPath = path.join(__dirname, '..', 'data', outputFile);
  let existing = { suggestions: {} };
  if (!FULL_REBUILD && !TEST_MODE) {
    try {
      existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      console.log(`Loaded existing suggestions: ${Object.keys(existing.suggestions).length} products\n`);
    } catch {
      console.log('No existing suggestions file found. Running full rebuild.\n');
    }
  }

  // 4. Determine which skirts need processing
  const activeSkirtIds = new Set(skirts.map(s => s.id));
  const activeTopIds = new Set(tops.map(t => t.id));
  let skirtsToProcess;

  if (FULL_REBUILD || TEST_MODE) {
    skirtsToProcess = skirts;
  } else {
    // Incremental: only skirts not already in suggestions
    const existingIds = new Set(Object.keys(existing.suggestions));
    skirtsToProcess = skirts.filter(s => !existingIds.has(s.id));
    console.log(`Incremental: ${skirtsToProcess.length} new skirts to process (${existingIds.size} already have suggestions)\n`);
  }

  // In test mode, cap at 2 batches worth
  if (TEST_MODE) {
    skirtsToProcess = skirtsToProcess.slice(0, BATCH_SIZE * 2);
    console.log(`Test mode: processing ${skirtsToProcess.length} skirts\n`);
  }

  // 5. Cleanup stale suggestions (remove products no longer active/available, remove stale top matches)
  if (!FULL_REBUILD && !TEST_MODE) {
    const before = Object.keys(existing.suggestions).length;
    for (const [productId, entry] of Object.entries(existing.suggestions)) {
      // Remove suggestion entries for skirts that are no longer active
      if (!activeSkirtIds.has(productId)) {
        delete existing.suggestions[productId];
        continue;
      }
      // Remove individual match tops that are no longer in the aimatchingtops collection
      entry.matches = entry.matches.filter(m => activeTopIds.has(m.productId));
    }
    const after = Object.keys(existing.suggestions).length;
    if (before !== after) {
      console.log(`Cleanup: removed ${before - after} stale skirt entries`);
    }
  }

  // 6. Build prompts and submit batch
  if (skirtsToProcess.length === 0) {
    console.log('No new skirts to process. Writing cleaned-up suggestions.\n');
  } else {
    const instructionsPath = path.join(__dirname, '..', 'data', 'matching-instructions.md');
    const instructions = fs.readFileSync(instructionsPath, 'utf-8');

    const topCatalog = tops.map(buildProductSummary).join('\n');

    // Collect curated match examples from all skirts
    const curatedExamples = [];
    [...skirts, ...tops].forEach(p => {
      if (p.curatedMatches.length > 0) {
        curatedExamples.push({
          product: `${p.title} (${p.productType})`,
          matchedWith: p.curatedMatches.map(m => m.title).join(', ')
        });
      }
    });
    const examplesText = curatedExamples.length
      ? curatedExamples.map(e => `- "${e.product}" was matched with: ${e.matchedWith}`).join('\n')
      : 'No curated examples available.';

    // Build batch requests (one per batch of skirts)
    const batchRequests = [];
    for (let i = 0; i < skirtsToProcess.length; i += BATCH_SIZE) {
      const batch = skirtsToProcess.slice(i, i + BATCH_SIZE);
      const batchSummaries = batch.map(buildProductSummary).join('\n');

      batchRequests.push({
        custom_id: `skirts-batch-${Math.floor(i / BATCH_SIZE)}`,
        params: {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          system: instructions,
          messages: [{
            role: 'user',
            content: `You are matching SKIRTS with TOPS. Below are the products to find matches for, the available tops catalog, and examples of existing curated matches to learn from.

EXISTING CURATED MATCH EXAMPLES (learn the matching patterns from these):
${examplesText}

SKIRTS TO FIND MATCHES FOR:
${batchSummaries}

AVAILABLE TOPS CATALOG:
${topCatalog}

For each skirt, suggest up to 10 tops that would pair well with it. Rank them best match first. Do NOT suggest products already in the skirt's curated match list.

Respond ONLY in this exact JSON format, no other text:
{
  "suggestions": [
    {
      "productId": "gid://shopify/Product/XXXXX",
      "suggestedMatches": [
        { "productId": "gid://shopify/Product/YYYYY", "reason": "brief reason", "confidence": 0.95 }
      ]
    }
  ]
}`
          }]
        }
      });
    }

    console.log(`Submitting ${batchRequests.length} batch requests to Claude Batch API...`);
    const batch = await createBatch(batchRequests);
    console.log(`  Batch created: ${batch.id}\n`);

    // Poll until done
    console.log('Waiting for batch to complete...');
    const completedBatch = await pollBatch(batch.id);
    console.log(`  Batch ended: ${completedBatch.request_counts.succeeded} succeeded, ${completedBatch.request_counts.errored} errored\n`);

    // Retrieve results
    console.log('Retrieving results...');
    const results = await getBatchResults(batch.id);

    // Process results
    let totalNew = 0;
    for (const result of results) {
      if (result.result.type !== 'succeeded') {
        console.error(`  Request ${result.custom_id} failed: ${result.result.type}`);
        continue;
      }

      const responseText = result.result.message.content?.[0]?.text || '';
      if (result.result.message.stop_reason === 'max_tokens') {
        console.log(`  Warning: ${result.custom_id} response was truncated`);
      }

      try {
        const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        // Figure out which batch this was from the custom_id
        const batchIdx = parseInt(result.custom_id.split('-').pop());
        const batchStart = batchIdx * BATCH_SIZE;
        const batch = skirtsToProcess.slice(batchStart, batchStart + BATCH_SIZE);

        for (const item of (parsed.suggestions || [])) {
          const product = batch.find(p => p.id === item.productId);
          if (!product) continue;

          const existingIds = new Set(product.curatedMatches.map(m => m.id).filter(Boolean));
          const filtered = (item.suggestedMatches || []).filter(m =>
            !existingIds.has(m.productId) && activeTopIds.has(m.productId)
          );

          const matches = filtered.map(m => {
            const matchProduct = tops.find(t => t.id === m.productId);
            return {
              productId: m.productId,
              title: matchProduct?.title || 'Unknown',
              handle: matchProduct?.handle || '',
              image: matchProduct?.image || null,
              price: matchProduct?.price || null,
              reason: m.reason,
              confidence: m.confidence || null
            };
          }).filter(m => m.title !== 'Unknown');

          if (matches.length > 0) {
            existing.suggestions[item.productId] = {
              productTitle: product.title,
              productHandle: product.handle,
              matches
            };
            totalNew++;
          }
        }
      } catch (e) {
        console.error(`  Failed to parse response for ${result.custom_id}: ${e.message}`);
        console.error(`  Preview: ${responseText.slice(0, 200)}`);
      }
    }

    console.log(`  Processed ${totalNew} new product suggestions\n`);
  }

  // 7. Write output
  const output = {
    generatedAt: new Date().toISOString(),
    totalProducts: Object.keys(existing.suggestions).length,
    totalSuggestions: Object.values(existing.suggestions).reduce((sum, s) => sum + s.matches.length, 0),
    suggestions: existing.suggestions
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Done! ${output.totalProducts} products with ${output.totalSuggestions} total suggestions`);
  console.log(`Output: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
