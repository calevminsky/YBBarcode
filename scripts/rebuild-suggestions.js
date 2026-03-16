#!/usr/bin/env node
/**
 * Nightly rebuild of AI-suggested product matches.
 *
 * Fetches all active skirts + tops from Shopify, reads their existing curated
 * matches (theme.upsell_list), then asks Claude to suggest additional matches
 * based on the patterns in the curated data.
 *
 * Output: data/suggestions.json
 *
 * Required env vars:
 *   SHOPIFY_ACCESS_TOKEN
 *   ANTHROPIC_API_KEY
 *   SHOPIFY_STORE (optional, defaults to yakirabella.myshopify.com)
 */

const fs = require('fs');
const path = require('path');

// ----- Config -----
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'yakirabella.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const API_VERSION = '2025-10';

if (!SHOPIFY_TOKEN) { console.error('Missing SHOPIFY_ACCESS_TOKEN'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ----- Shopify GraphQL helper -----
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  return res.json();
}

// ----- Claude API helper -----
async function askClaude(systemPrompt, userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
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
                inventoryQuantity
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

async function fetchAllProducts(productType) {
  const allProducts = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    console.log(`  Fetching ${productType} page ${page}...`);
    const result = await shopifyGraphQL(FETCH_PRODUCTS_QUERY, {
      query: `product_type:'${productType}' AND status:active`,
      cursor
    });

    const data = result.data?.products;
    if (!data) break;

    for (const edge of data.edges) {
      const p = edge.node;
      const totalInventory = p.variants.edges.reduce((sum, v) => sum + (v.node.inventoryQuantity || 0), 0);

      // Extract metafields
      const metafields = {};
      for (const mfEdge of (p.metafields?.edges || [])) {
        const mf = mfEdge.node;
        metafields[`${mf.namespace}.${mf.key}`] = mf.value;
      }

      // Extract existing curated matches
      const curatedMatches = [];
      const upsellMeta = p.upsellMeta;
      if (upsellMeta) {
        const refs = upsellMeta.references?.nodes || [];
        if (refs.length) {
          refs.forEach(r => curatedMatches.push({ id: r.id, title: r.title, handle: r.handle }));
        } else if (upsellMeta.value) {
          // Text-based upsells — just store the raw handles/titles
          const tokens = upsellMeta.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
          tokens.forEach(t => curatedMatches.push({ handle: t, title: t }));
        }
      }

      allProducts.push({
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
      });
    }

    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }

  return allProducts;
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
  console.log('Starting suggestion rebuild...\n');

  // 1. Fetch all products
  console.log('Fetching skirts...');
  const skirts = await fetchAllProducts('Skirts');
  console.log(`  Found ${skirts.length} active skirts`);

  console.log('Fetching tops...');
  const tops = await fetchAllProducts('Tops');
  console.log(`  Found ${tops.length} active tops\n`);

  // Filter out very low stock
  const availableSkirts = skirts.filter(p => p.totalInventory > 2);
  const availableTops = tops.filter(p => p.totalInventory > 2);
  console.log(`After filtering low stock: ${availableSkirts.length} skirts, ${availableTops.length} tops\n`);

  // 2. Load matching instructions
  const instructionsPath = path.join(__dirname, '..', 'data', 'matching-instructions.md');
  const instructions = fs.readFileSync(instructionsPath, 'utf-8');

  // 3. Build catalogs
  const skirtCatalog = availableSkirts.map(buildProductSummary).join('\n');
  const topCatalog = availableTops.map(buildProductSummary).join('\n');

  // 4. Collect existing curated match examples
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

  // 5. Ask Claude for suggestions in batches
  const suggestions = {};
  const BATCH_SIZE = 20;

  // Process skirts -> suggest tops
  console.log('Generating suggestions for skirts (matching with tops)...');
  for (let i = 0; i < availableSkirts.length; i += BATCH_SIZE) {
    const batch = availableSkirts.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(availableSkirts.length / BATCH_SIZE)} (${batch.length} skirts)...`);

    const batchSummaries = batch.map(buildProductSummary).join('\n');
    const existingMatchIds = new Set();
    batch.forEach(p => p.curatedMatches.forEach(m => { if (m.id) existingMatchIds.add(m.id); }));

    const response = await askClaude(
      instructions,
      `You are matching SKIRTS with TOPS. Below are the products to find matches for, the available tops catalog, and examples of existing curated matches to learn from.

EXISTING CURATED MATCH EXAMPLES (learn the matching patterns from these):
${examplesText}

SKIRTS TO FIND MATCHES FOR:
${batchSummaries}

AVAILABLE TOPS CATALOG:
${topCatalog}

For each skirt, suggest 3-6 tops that would pair well with it. Do NOT suggest products already in the skirt's curated match list.

Respond ONLY in this exact JSON format, no other text:
{
  "suggestions": [
    {
      "productId": "gid://shopify/Product/XXXXX",
      "suggestedMatches": [
        { "productId": "gid://shopify/Product/YYYYY", "reason": "brief reason" }
      ]
    }
  ]
}`
    );

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      for (const item of (parsed.suggestions || [])) {
        const product = batch.find(p => p.id === item.productId);
        if (!product) continue;
        const existingIds = new Set(product.curatedMatches.map(m => m.id).filter(Boolean));
        const filtered = (item.suggestedMatches || []).filter(m => !existingIds.has(m.productId));
        // Enrich with product data
        suggestions[item.productId] = {
          productTitle: product.title,
          productHandle: product.handle,
          matches: filtered.map(m => {
            const matchProduct = availableTops.find(t => t.id === m.productId);
            return {
              productId: m.productId,
              title: matchProduct?.title || 'Unknown',
              handle: matchProduct?.handle || '',
              image: matchProduct?.image || null,
              price: matchProduct?.price || null,
              reason: m.reason
            };
          }).filter(m => m.title !== 'Unknown') // Remove any that weren't found in catalog
        };
      }
    } catch (e) {
      console.error(`  Failed to parse Claude response for batch: ${e.message}`);
      console.error(`  Response preview: ${response.slice(0, 200)}`);
    }

    // Rate limit: small delay between batches
    if (i + BATCH_SIZE < availableSkirts.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Process tops -> suggest skirts
  console.log('\nGenerating suggestions for tops (matching with skirts)...');
  for (let i = 0; i < availableTops.length; i += BATCH_SIZE) {
    const batch = availableTops.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(availableTops.length / BATCH_SIZE)} (${batch.length} tops)...`);

    const batchSummaries = batch.map(buildProductSummary).join('\n');

    const response = await askClaude(
      instructions,
      `You are matching TOPS with SKIRTS. Below are the products to find matches for, the available skirts catalog, and examples of existing curated matches to learn from.

EXISTING CURATED MATCH EXAMPLES (learn the matching patterns from these):
${examplesText}

TOPS TO FIND MATCHES FOR:
${batchSummaries}

AVAILABLE SKIRTS CATALOG:
${skirtCatalog}

For each top, suggest 3-6 skirts that would pair well with it. Do NOT suggest products already in the top's curated match list.

Respond ONLY in this exact JSON format, no other text:
{
  "suggestions": [
    {
      "productId": "gid://shopify/Product/XXXXX",
      "suggestedMatches": [
        { "productId": "gid://shopify/Product/YYYYY", "reason": "brief reason" }
      ]
    }
  ]
}`
    );

    try {
      const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      for (const item of (parsed.suggestions || [])) {
        const product = batch.find(p => p.id === item.productId);
        if (!product) continue;
        const existingIds = new Set(product.curatedMatches.map(m => m.id).filter(Boolean));
        const filtered = (item.suggestedMatches || []).filter(m => !existingIds.has(m.productId));
        suggestions[item.productId] = {
          productTitle: product.title,
          productHandle: product.handle,
          matches: filtered.map(m => {
            const matchProduct = availableSkirts.find(s => s.id === m.productId);
            return {
              productId: m.productId,
              title: matchProduct?.title || 'Unknown',
              handle: matchProduct?.handle || '',
              image: matchProduct?.image || null,
              price: matchProduct?.price || null,
              reason: m.reason
            };
          }).filter(m => m.title !== 'Unknown')
        };
      }
    } catch (e) {
      console.error(`  Failed to parse Claude response for batch: ${e.message}`);
      console.error(`  Response preview: ${response.slice(0, 200)}`);
    }

    if (i + BATCH_SIZE < availableTops.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 6. Write output
  const output = {
    generatedAt: new Date().toISOString(),
    totalProducts: Object.keys(suggestions).length,
    totalSuggestions: Object.values(suggestions).reduce((sum, s) => sum + s.matches.length, 0),
    suggestions
  };

  const outputPath = path.join(__dirname, '..', 'data', 'suggestions.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\nDone! Generated suggestions for ${output.totalProducts} products (${output.totalSuggestions} total matches)`);
  console.log(`Output: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
