const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const SHOPIFY_STORE = 'yakirabella.myshopify.com';
const ACCESS_TOKEN = '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';

// Simple GraphQL test
app.post('/lookup', async (req, res) => {
  try {
    const { barcode } = req.body;
    
    // For now, just return a test response
    res.json({
      status: 'GraphQL test',
      barcode: barcode,
      message: 'Service is working'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve the frontend HTML file
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
