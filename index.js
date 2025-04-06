// index.js - SQL Middleware main file with improved error handling
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sql = require('mssql');
const app = express();

// Log important information on startup
console.log('==== Wix SQL Middleware Starting ====');
console.log('Node.js version:', process.version);
console.log('Environment:', process.env.NODE_ENV);
console.log('Port:', process.env.PORT);
console.log('Database info:');
console.log('- Server:', process.env.DB_SERVER);
console.log('- Database:', process.env.DB_NAME);
console.log('- User:', process.env.DB_USER);
console.log('- Password length:', process.env.DB_PASSWORD ? process.env.DB_PASSWORD.length : 0);

// Middleware
app.use(cors({
  origin: '*', // Allow all origins for testing, restrict in production
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// Database configuration
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true, // Required for Azure SQL
    trustServerCertificate: process.env.NODE_ENV !== 'production',
    connectTimeout: 30000, // Longer timeout for Azure SQL connections
    requestTimeout: 30000,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  }
};

// Global SQL pool
let pool;

// Initialize connection pool with retry logic
async function initializePool(retryCount = 5) {
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`Attempting to connect to SQL Server (attempt ${attempt}/${retryCount})...`);
      
      // Close existing pool if it exists
      if (pool) {
        try {
          await pool.close();
          console.log('Closed existing pool');
        } catch (closeErr) {
          console.warn('Error closing existing pool:', closeErr.message);
        }
      }
      
      // Create new pool
      pool = await sql.connect(dbConfig);
      console.log('✅ Connected to SQL Server successfully!');
      
      // Test the connection with a simple query
      const testResult = await pool.request().query('SELECT @@VERSION AS version');
      console.log('SQL Server Version:', testResult.recordset[0].version);
      
      return pool;
    } catch (err) {
      console.error(`❌ Database connection attempt ${attempt} failed:`, err.message);
      
      if (err.code) {
        console.error('Error code:', err.code);
      }
      
      if (attempt < retryCount) {
        const delay = 2000 * attempt; // Exponential backoff
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('Maximum retry attempts reached. Could not connect to database.');
        throw err;
      }
    }
  }
}

// Basic route for root path
app.get('/', (req, res) => {
  res.status(200).send('Wix SQL Middleware API is running. Use /api/health to check status.');
});

// Health check endpoint with database status
app.get('/api/health', async (req, res) => {
  const dbStatus = { connected: false, message: 'Not initialized' };
  
  try {
    if (!pool) {
      dbStatus.message = 'Connection pool not initialized';
    } else {
      // Test if the pool is still valid with a lightweight query
      await pool.request().query('SELECT 1 AS result');
      dbStatus.connected = true;
      dbStatus.message = 'Connected';
    }
  } catch (err) {
    dbStatus.message = `Error: ${err.message}`;
    // Try to reinitialize the pool
    initializePool(1).catch(() => {});
  }
  
  res.status(200).json({
    status: 'OK',
    message: 'Service is running',
    environment: process.env.NODE_ENV,
    node_version: process.version,
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Execute a SQL query with better error handling
app.post('/api/query', async (req, res) => {
  try {
    console.log('Received query request:', JSON.stringify(req.body, null, 2).substring(0, 200) + '...');
    const { query, params } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Ensure pool is initialized
    if (!pool) {
      console.log('Pool not initialized, attempting to initialize...');
      await initializePool();
    }

    // Create request object
    const request = pool.request();

    // Add parameters if they exist
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(key => {
        console.log(`Adding parameter ${key} with value ${params[key]}`);
        request.input(key, params[key]);
      });
    }

    // Execute query
    console.log('Executing query...');
    const result = await request.query(query);
    console.log(`Query executed successfully. Rows affected: ${result.rowsAffected[0]}, Records returned: ${result.recordset ? result.recordset.length : 0}`);
    
    res.status(200).json({ 
      success: true, 
      data: result.recordset,
      rowsAffected: result.rowsAffected[0] 
    });
  } catch (err) {
    console.error('Query execution error:', err);
    
    // Check for connection issues and try to reconnect
    if (err.code === 'ETIMEOUT' || err.code === 'ECONNCLOSED' || err.code === 'ECONNRESET' || !pool) {
      console.log('Connection issue detected, attempting to reconnect...');
      try {
        await initializePool(1);
      } catch (reconnectErr) {
        console.error('Reconnection failed:', reconnectErr.message);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Execute a stored procedure with better error handling
app.post('/api/procedure', async (req, res) => {
  try {
    console.log('Received procedure request:', JSON.stringify(req.body, null, 2).substring(0, 200) + '...');
    const { procedure, params } = req.body;
    
    if (!procedure) {
      return res.status(400).json({ error: 'Procedure name is required' });
    }

    // Ensure pool is initialized
    if (!pool) {
      console.log('Pool not initialized, attempting to initialize...');
      await initializePool();
    }

    // Create request object
    const request = pool.request();

    // Add parameters if they exist
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(key => {
        console.log(`Adding parameter ${key} with value ${params[key]}`);
        request.input(key, params[key]);
      });
    }

    // Execute stored procedure
    console.log(`Executing procedure: ${procedure}...`);
    const result = await request.execute(procedure);
    console.log(`Procedure executed successfully. Rows affected: ${result.rowsAffected[0]}, Records returned: ${result.recordset ? result.recordset.length : 0}`);
    
    res.status(200).json({ 
      success: true, 
      data: result.recordset,
      outputParameters: result.output,
      rowsAffected: result.rowsAffected[0]
    });
  } catch (err) {
    console.error('Procedure execution error:', err);
    
    // Check for connection issues and try to reconnect
    if (err.code === 'ETIMEOUT' || err.code === 'ECONNCLOSED' || err.code === 'ECONNRESET' || !pool) {
      console.log('Connection issue detected, attempting to reconnect...');
      try {
        await initializePool(1);
      } catch (reconnectErr) {
        console.error('Reconnection failed:', reconnectErr.message);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Bulk operations with better error handling
app.post('/api/bulk', async (req, res) => {
  try {
    console.log('Received bulk operation request');
    const { table, data } = req.body;
    
    if (!table || !data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: 'Valid table name and data array are required' });
    }

    console.log(`Bulk operation: table=${table}, data rows=${data.length}`);

    // Ensure pool is initialized
    if (!pool) {
      console.log('Pool not initialized, attempting to initialize...');
      await initializePool();
    }

    // Get column names from first data item
    const columns = Object.keys(data[0]);
    console.log(`Columns: ${columns.join(', ')}`);
    
    // Create a new Table
    const bulkTable = new sql.Table(table);
    
    // Add columns to the table
    columns.forEach(column => {
      // Default to VarChar(MAX) for flexibility
      bulkTable.columns.add(column, sql.VarChar(sql.MAX), { nullable: true });
    });
    
    // Add rows to the table
    data.forEach((item, index) => {
      if (index < 5) console.log(`Adding row ${index}:`, item);
      const rowValues = columns.map(col => item[col]);
      bulkTable.rows.add(...rowValues);
    });
    
    // Execute bulk insert
    console.log('Executing bulk insert...');
    const result = await pool.request().bulk(bulkTable);
    console.log(`Bulk insert completed. Rows affected: ${result.rowsAffected}`);
    
    res.status(200).json({
      success: true,
      rowsAffected: result.rowsAffected
    });
  } catch (err) {
    console.error('Bulk operation error:', err);
    
    // Check for connection issues and try to reconnect
    if (err.code === 'ETIMEOUT' || err.code === 'ECONNCLOSED' || err.code === 'ECONNRESET' || !pool) {
      console.log('Connection issue detected, attempting to reconnect...');
      try {
        await initializePool(1);
      } catch (reconnectErr) {
        console.error('Reconnection failed:', reconnectErr.message);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Transaction support with better error handling
app.post('/api/transaction', async (req, res) => {
  let transaction;
  
  try {
    console.log('Received transaction request');
    const { queries } = req.body;
    
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Valid queries array is required' });
    }

    console.log(`Transaction containing ${queries.length} queries`);

    // Ensure pool is initialized
    if (!pool) {
      console.log('Pool not initialized, attempting to initialize...');
      await initializePool();
    }
    
    // Create transaction
    transaction = new sql.Transaction(pool);
    
    // Begin transaction
    console.log('Beginning transaction...');
    await transaction.begin();
    
    const results = [];
    
    // Execute each query in the transaction
    for (let i = 0; i < queries.length; i++) {
      const queryInfo = queries[i];
      const { query, params } = queryInfo;
      
      console.log(`Executing transaction query ${i+1}/${queries.length}`);
      
      const request = new sql.Request(transaction);
      
      // Add parameters if they exist
      if (params && typeof params === 'object') {
        Object.keys(params).forEach(key => {
          console.log(`Adding parameter ${key} with value ${params[key]}`);
          request.input(key, params[key]);
        });
      }
      
      // Execute query
      const result = await request.query(query);
      results.push({
        data: result.recordset,
        rowsAffected: result.rowsAffected[0]
      });
      
      console.log(`Query ${i+1} completed. Rows affected: ${result.rowsAffected[0]}`);
    }
    
    // Commit transaction
    console.log('Committing transaction...');
    await transaction.commit();
    console.log('Transaction committed successfully');
    
    res.status(200).json({
      success: true,
      results
    });
  } catch (err) {
    console.error('Transaction error:', err);
    
    // Rollback transaction on error
    if (transaction) {
      try {
        console.log('Rolling back transaction...');
        await transaction.rollback();
        console.log('Transaction rolled back');
      } catch (rollbackErr) {
        console.error('Transaction rollback failed:', rollbackErr);
      }
    }
    
    // Check for connection issues and try to reconnect
    if (err.code === 'ETIMEOUT' || err.code === 'ECONNCLOSED' || err.code === 'ECONNRESET' || !pool) {
      console.log('Connection issue detected, attempting to reconnect...');
      try {
        await initializePool(1);
      } catch (reconnectErr) {
        console.error('Reconnection failed:', reconnectErr.message);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: err.message,
      errorCode: err.code,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Database diagnostics endpoint
app.get('/api/diagnostics', async (req, res) => {
  try {
    const diagnostics = {
      environment: process.env.NODE_ENV,
      node_version: process.version,
      db_config: {
        server: process.env.DB_SERVER,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD ? '********' : undefined
      },
      pool_initialized: !!pool,
      timestamp: new Date().toISOString()
    };
    
    // Test connection if pool exists
    if (pool) {
      try {
        const testResult = await pool.request().query('SELECT @@VERSION AS version');
        diagnostics.connection_test = {
          success: true,
          sql_version: testResult.recordset[0].version
        };
        
        // Get list of tables
        const tablesResult = await pool.request().query(`
          SELECT TABLE_NAME 
          FROM INFORMATION_SCHEMA.TABLES 
          WHERE TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME
        `);
        
        diagnostics.tables = tablesResult.recordset.map(r => r.TABLE_NAME);
      } catch (testErr) {
        diagnostics.connection_test = {
          success: false,
          error: testErr.message
        };
      }
    }
    
    res.status(200).json(diagnostics);
  } catch (err) {
    console.error('Diagnostics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Start the server
const PORT = process.env.PORT || 3000;

// Initialize the DB pool before starting the server
initializePool()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`Health check available at: http://localhost:${PORT}/api/health`);
      console.log(`Diagnostics available at: http://localhost:${PORT}/api/diagnostics`);
    });
  })
  .catch(err => {
    console.error('⛔ Failed to initialize the application:', err);
    // Start server anyway to allow diagnostics
    app.listen(PORT, () => {
      console.log(`⚠️ Server running on port ${PORT} but database connection failed`);
      console.log(`Health check available at: http://localhost:${PORT}/api/health`);
    });
  });

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing SQL connection pool...');
  if (pool) {
    try {
      await pool.close();
      console.log('SQL connection pool closed');
    } catch (err) {
      console.error('Error closing SQL connection pool:', err);
    }
  }
  console.log('Server shutting down...');
  process.exit(0);
});

// Log uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// Log unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app; // For testing purposes
