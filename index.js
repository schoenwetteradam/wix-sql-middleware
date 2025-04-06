// Simple version of index.js to test functionality
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sql = require('mssql');
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database configuration
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

// Global SQL pool
let pool;

// Basic route for root path
app.get('/', (req, res) => {
  res.status(200).send('Wix SQL Middleware API is running. Use /api/health to check status.');
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Service is running',
    environment: process.env.NODE_ENV
  });
});

// Connect to database and execute query
app.post('/api/query', async (req, res) => {
  try {
    const { query, params } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Connect to database
    if (!pool) {
      pool = await sql.connect(dbConfig);
      console.log('Connected to SQL Server');
    }

    // Create request
    const request = pool.request();

    // Add parameters
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(key => {
        request.input(key, params[key]);
      });
    }

    // Execute query
    const result = await request.query(query);
    
    res.status(200).json({ 
      success: true, 
      data: result.recordset,
      rowsAffected: result.rowsAffected[0] 
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message
    });
  }
});

// Execute a stored procedure
app.post('/api/procedure', async (req, res) => {
  try {
    const { procedure, params } = req.body;
    
    if (!procedure) {
      return res.status(400).json({ error: 'Procedure name is required' });
    }

    // Connect to database
    if (!pool) {
      pool = await sql.connect(dbConfig);
      console.log('Connected to SQL Server');
    }

    // Create request
    const request = pool.request();

    // Add parameters
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(key => {
        request.input(key, params[key]);
      });
    }

    // Execute stored procedure
    const result = await request.execute(procedure);
    
    res.status(200).json({ 
      success: true, 
      data: result.recordset,
      outputParameters: result.output,
      rowsAffected: result.rowsAffected[0]
    });
  } catch (err) {
    console.error('Procedure error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
