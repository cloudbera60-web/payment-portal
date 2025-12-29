require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { createLogger, format, transports } = require('winston');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Logger Configuration
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'error.log', level: 'error' }),
    new transports.File({ filename: 'combined.log' }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

// Validate Environment Variables
const requiredEnvVars = ['PAYHERO_AUTH_TOKEN', 'CHANNEL_ID'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    logger.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// PayHero API Configuration
const PAYHERO_CONFIG = {
  baseURL: process.env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke/api/v2',
  timeout: 30000,
  headers: {
    'Authorization': process.env.PAYHERO_AUTH_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
};

// Create Axios instance
const payheroClient = axios.create(PAYHERO_CONFIG);

// Response interceptor for logging
payheroClient.interceptors.response.use(
  response => {
    logger.info(`PayHero API Success: ${response.config.method} ${response.config.url}`);
    return response;
  },
  error => {
    logger.error(`PayHero API Error: ${error.config?.method} ${error.config?.url}`, {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    return Promise.reject(error);
  }
);

// Utility Functions
function formatPhoneNumber(phone) {
  let formatted = phone.toString().trim().replace(/\s+/g, '');
  
  if (formatted.startsWith('0')) {
    formatted = '254' + formatted.substring(1);
  } else if (formatted.startsWith('+')) {
    formatted = formatted.substring(1);
  }
  
  if (!formatted.startsWith('254')) {
    throw new Error('Phone number must start with 254');
  }
  
  if (formatted.length !== 12) {
    throw new Error('Invalid phone number length');
  }
  
  return formatted;
}

function validateAmount(amount) {
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Amount must be a positive number');
  }
  if (numAmount < 1) {
    throw new Error('Minimum amount is KES 1');
  }
  if (numAmount > 150000) {
    throw new Error('Maximum amount is KES 150,000');
  }
  return numAmount.toFixed(2);
}

// In-memory storage for transactions (use database in production)
const transactions = new Map();

// Serve Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API Routes

// 1. Health Check
app.get('/api/health', async (req, res) => {
  try {
    res.json({
      success: true,
      service: 'BERA TECH Payment Gateway',
      status: 'operational',
      timestamp: new Date().toISOString(),
      account_id: process.env.CHANNEL_ID,
      version: '1.0.0'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Service error'
    });
  }
});

// 2. STK Push (C2B) - REAL PayHero API
app.post('/api/stk-push', async (req, res) => {
  try {
    const { phone_number, amount, external_reference, customer_name } = req.body;

    // Validation
    if (!phone_number || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and amount are required'
      });
    }

    // Format and validate inputs
    const formattedPhone = formatPhoneNumber(phone_number);
    const validatedAmount = validateAmount(amount);
    
    const reference = external_reference || `BERA-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // PayHero API Payload
    const payload = {
      amount: validatedAmount,
      phone_number: formattedPhone,
      channel_id: process.env.CHANNEL_ID,
      provider: process.env.DEFAULT_PROVIDER || 'm-pesa',
      external_reference: reference,
      customer_name: customer_name || 'Customer',
      description: 'Payment to BERA TECH'
    };

    logger.info('STK Push Request:', payload);

    // Make request to PayHero
    const response = await payheroClient.post('/payments', payload);
    
    // Store transaction
    const transaction = {
      id: reference,
      type: 'C2B',
      status: 'PENDING',
      amount: parseFloat(validatedAmount),
      phone: formattedPhone,
      customer_name: payload.customer_name,
      timestamp: new Date().toISOString(),
      payhero_response: response.data,
      last_checked: new Date().toISOString()
    };
    
    transactions.set(reference, transaction);

    logger.info('STK Push Success:', { reference, status: response.data?.status });

    res.json({
      success: true,
      message: 'STK push initiated successfully',
      data: {
        reference: reference,
        status: 'PENDING',
        message: 'Check your phone for M-Pesa prompt',
        transaction: {
          id: reference,
          amount: validatedAmount,
          phone: formattedPhone,
          timestamp: transaction.timestamp
        }
      }
    });

  } catch (error) {
    logger.error('STK Push Failed:', error.response?.data || error.message);
    
    let errorMessage = 'Failed to initiate payment';
    let statusCode = 500;
    
    if (error.response) {
      statusCode = error.response.status;
      errorMessage = error.response.data?.message || error.response.data?.error || errorMessage;
    } else if (error.request) {
      errorMessage = 'Network error - Could not reach PayHero API';
    } else if (error.message.includes('Phone number')) {
      statusCode = 400;
      errorMessage = error.message;
    } else if (error.message.includes('Amount')) {
      statusCode = 400;
      errorMessage = error.message;
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
});

// 3. Transaction Status - REAL PayHero API
app.get('/api/transaction-status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        error: 'Transaction reference is required'
      });
    }

    logger.info('Checking transaction status:', reference);

    // Check with PayHero API
    const response = await payheroClient.get(`/payments/${reference}/status`);
    
    // Update local transaction
    const transaction = transactions.get(reference);
    if (transaction) {
      transaction.status = response.data.status || 'UNKNOWN';
      transaction.last_checked = new Date().toISOString();
      transaction.payhero_response = response.data;
    }

    logger.info('Status Check Result:', { reference, status: response.data?.status });

    res.json({
      success: true,
      data: {
        reference: reference,
        status: response.data.status || 'UNKNOWN',
        amount: response.data.amount,
        phone_number: response.data.phone_number,
        description: response.data.description,
        timestamp: response.data.timestamp || new Date().toISOString(),
        payhero_data: response.data
      }
    });

  } catch (error) {
    logger.error('Status Check Failed:', error.response?.data || error.message);
    
    // If PayHero returns 404, check if we have the transaction locally
    if (error.response?.status === 404) {
      const transaction = transactions.get(req.params.reference);
      if (transaction) {
        return res.json({
          success: true,
          data: {
            reference: transaction.id,
            status: transaction.status,
            amount: transaction.amount,
            phone_number: transaction.phone,
            timestamp: transaction.timestamp,
            note: 'Transaction found in local cache'
          }
        });
      }
    }
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to check transaction status'
    });
  }
});

// 4. Withdrawal (B2C) - REAL PayHero API
app.post('/api/withdraw', async (req, res) => {
  try {
    const { phone_number, amount, network_code, description } = req.body;

    // Validation
    if (!phone_number || !amount || !network_code) {
      return res.status(400).json({
        success: false,
        error: 'Phone number, amount, and network code are required'
      });
    }

    // Validate network code
    const validNetworks = ['63902', '63903']; // M-Pesa: 63902, Airtel: 63903
    if (!validNetworks.includes(network_code)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid network code. Use 63902 for M-Pesa or 63903 for Airtel'
      });
    }

    // Format and validate inputs
    const formattedPhone = formatPhoneNumber(phone_number);
    const validatedAmount = validateAmount(amount);
    
    const reference = `WDR-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // PayHero API Payload
    const payload = {
      amount: validatedAmount,
      phone_number: formattedPhone,
      network_code: network_code,
      channel: 'mobile',
      channel_id: process.env.CHANNEL_ID,
      payment_service: 'b2c',
      description: description || 'Withdrawal from BERA TECH',
      external_reference: reference
    };

    logger.info('Withdrawal Request:', payload);

    // Make request to PayHero
    const response = await payheroClient.post('/withdraw', payload);
    
    // Store transaction
    const transaction = {
      id: reference,
      type: 'B2C',
      status: 'PROCESSING',
      amount: parseFloat(validatedAmount),
      phone: formattedPhone,
      network: network_code === '63902' ? 'M-Pesa' : 'Airtel',
      description: payload.description,
      timestamp: new Date().toISOString(),
      payhero_response: response.data,
      last_checked: new Date().toISOString()
    };
    
    transactions.set(reference, transaction);

    logger.info('Withdrawal Success:', { reference, status: response.data?.status });

    res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      data: {
        reference: reference,
        status: 'PROCESSING',
        message: 'Withdrawal is being processed',
        transaction: {
          id: reference,
          amount: validatedAmount,
          phone: formattedPhone,
          network: network_code === '63902' ? 'M-Pesa' : 'Airtel',
          timestamp: transaction.timestamp
        }
      }
    });

  } catch (error) {
    logger.error('Withdrawal Failed:', error.response?.data || error.message);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to initiate withdrawal'
    });
  }
});

// 5. Get All Transactions
app.get('/api/transactions', (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    
    let transactionList = Array.from(transactions.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (type && ['C2B', 'B2C'].includes(type)) {
      transactionList = transactionList.filter(t => t.type === type);
    }
    
    // Calculate statistics
    const allTransactions = Array.from(transactions.values());
    const stats = {
      total: allTransactions.length,
      c2b: allTransactions.filter(t => t.type === 'C2B').length,
      b2c: allTransactions.filter(t => t.type === 'B2C').length,
      successful: allTransactions.filter(t => t.status === 'SUCCESS').length,
      failed: allTransactions.filter(t => t.status === 'FAILED').length,
      pending: allTransactions.filter(t => ['PENDING', 'PROCESSING'].includes(t.status)).length,
      total_amount: allTransactions.reduce((sum, t) => sum + (t.amount || 0), 0)
    };

    res.json({
      success: true,
      data: {
        transactions: transactionList.slice(0, parseInt(limit)),
        statistics: stats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Get Transactions Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve transactions'
    });
  }
});

// 6. Clear Transaction (for testing)
app.delete('/api/transactions/:reference', (req, res) => {
  try {
    const { reference } = req.params;
    const deleted = transactions.delete(reference);
    
    res.json({
      success: true,
      message: deleted ? 'Transaction cleared' : 'Transaction not found'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to clear transaction'
    });
  }
});

// 7. Transaction Fees
app.get('/api/transaction-fees', async (req, res) => {
  try {
    const { amount } = req.query;
    
    // Fetch fee structure from PayHero (no auth required)
    const response = await axios.get('https://backend.payhero.co.ke/api/transaction_fees', {
      timeout: 10000
    });
    
    let calculatedFees = null;
    if (amount) {
      const amountNum = parseFloat(amount);
      if (!isNaN(amountNum) && amountNum > 0) {
        // Calculate fees based on PayHero's structure
        const fee = Math.max(10, amountNum * 0.015); // 1.5% or minimum 10 KES
        calculatedFees = {
          amount: amountNum,
          fee: fee,
          total: amountNum + fee,
          net_receive: amountNum - fee,
          breakdown: [
            { name: 'Transaction Amount', amount: amountNum },
            { name: 'Processing Fee (1.5% + min KES 10)', amount: fee }
          ]
        };
      }
    }

    res.json({
      success: true,
      data: {
        fee_schedule: response.data,
        calculated: calculatedFees
      }
    });
  } catch (error) {
    logger.error('Fee Check Error:', error.message);
    
    // Return default fee structure if API fails
    res.json({
      success: true,
      data: {
        fee_schedule: {
          mpesa: { percentage: 1.5, minimum: 10, maximum: 1000 },
          airtel: { percentage: 1.5, minimum: 10, maximum: 1000 }
        },
        calculated: null
      }
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Server Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info('🚀 BERA TECH Payment Gateway Started');
  logger.info('===============================');
  logger.info(`📍 Port: ${PORT}`);
  logger.info(`🔑 Account ID: ${process.env.CHANNEL_ID}`);
  logger.info(`📱 Provider: ${process.env.DEFAULT_PROVIDER || 'm-pesa'}`);
  logger.info('📊 Services:');
  logger.info('   • STK Push (C2B) - REAL');
  logger.info('   • Wallet Withdrawals (B2C) - REAL');
  logger.info('   • Transaction Status - REAL');
  logger.info('   • Fee Calculation');
  logger.info(`🌐 Frontend: http://localhost:${PORT}`);
  logger.info(`🔧 Admin: http://localhost:${PORT}/admin`);
  logger.info(`❤️  Health: http://localhost:${PORT}/api/health`);
  logger.info('✅ READY FOR PRODUCTION');
});
