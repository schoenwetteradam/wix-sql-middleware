// index.js - SQL Middleware main file
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

// Database configuration - CORRECTED
const dbConfig = {
  user: process.env.DB_USER,         // Changed from salonadmin.DB_USER
  password: process.env.DB_PASSWORD, // Changed from Keepingitcut3.DB_PASSWORD
  server: process.env.DB_SERVER,     // Changed from salondatabase.DB_SERVER
  database: process.env.DB_NAME,
  options: {
    encrypt: true, // Use this if connecting to Azure SQL
    trustServerCertificate: process.env.NODE_ENV !== 'production' // For local dev
  }
};

// Global SQL pool
let pool;

// Initialize connection pool
async function initializePool() {
  try {
    pool = await sql.connect(dbConfig);
    console.log('Connected to SQL Server successfully');
  } catch (err) {
    console.error('Database connection failed:', err);
  }
}

// API Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Service is running' });
});

// Execute a SQL query
app.post('/api/query', async (req, res) => {
  try {
    const { query, params } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Ensure pool is initialized
    if (!pool) {
      await initializePool();
    }

    // Create request object
    const request = pool.request();

    // Add parameters if they exist
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
    console.error('Query execution error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code
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

    // Ensure pool is initialized
    if (!pool) {
      await initializePool();
    }

    // Create request object
    const request = pool.request();

    // Add parameters if they exist
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
    console.error('Procedure execution error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code
    });
  }
});

// Bulk operations
app.post('/api/bulk', async (req, res) => {
  try {
    const { table, data } = req.body;
    
    if (!table || !data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: 'Valid table name and data array are required' });
    }

    // Ensure pool is initialized
    if (!pool) {
      await initializePool();
    }

    // Get column names from first data item
    const columns = Object.keys(data[0]);
    
    // Create a new Table
    const bulkTable = new sql.Table(table);
    
    // Add columns to the table
    columns.forEach(column => {
      // You might want to specify the exact SQL type for each column
      bulkTable.columns.add(column, sql.VarChar(sql.MAX), { nullable: true });
    });
    
    // Add rows to the table
    data.forEach(item => {
      const rowValues = columns.map(col => item[col]);
      bulkTable.rows.add(...rowValues);
    });
    
    // Execute bulk insert
    const result = await pool.request().bulk(bulkTable);
    
    res.status(200).json({
      success: true,
      rowsAffected: result.rowsAffected
    });
  } catch (err) {
    console.error('Bulk operation error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code
    });
  }
});

// Transaction support
app.post('/api/transaction', async (req, res) => {
  const transaction = new sql.Transaction(pool);
  
  try {
    const { queries } = req.body;
    
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Valid queries array is required' });
    }

    // Ensure pool is initialized
    if (!pool) {
      await initializePool();
    }
    
    // Begin transaction
    await transaction.begin();
    
    const results = [];
    
    // Execute each query in the transaction
    for (const queryInfo of queries) {
      const { query, params } = queryInfo;
      
      const request = new sql.Request(transaction);
      
      // Add parameters if they exist
      if (params && typeof params === 'object') {
        Object.keys(params).forEach(key => {
          request.input(key, params[key]);
        });
      }
      
      // Execute query
      const result = await request.query(query);
      results.push({
        data: result.recordset,
        rowsAffected: result.rowsAffected[0]
      });
    }
    
    // Commit transaction
    await transaction.commit();
    
    res.status(200).json({
      success: true,
      results
    });
  } catch (err) {
    // Rollback transaction on error
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('Transaction rollback failed:', rollbackErr);
    }
    
    console.error('Transaction error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start the server
const PORT = process.env.PORT || 3000;

// Initialize the DB pool before starting the server
initializePool().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize the application:', err);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing SQL connection pool...');
  if (pool) {
    await pool.close();
  }
  console.log('Server shutting down...');
  process.exit(0);
});

module.exports = app; // For testing purposes