// server.js - Complete Backend Implementation
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required environment variables
const requiredEnvVars = ['PAYHERO_AUTH_TOKEN', 'CHANNEL_ID'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.static('public'));

// PayHero API Configuration
const PAYHERO_CONFIG = {
  baseURL: process.env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke/api/v2',
  headers: {
    'Authorization': process.env.PAYHERO_AUTH_TOKEN,
    'Content-Type': 'application/json'
  }
};

// PayHero API Client
const payheroClient = axios.create(PAYHERO_CONFIG);

// Utility Functions
function formatPhoneNumber(phone) {
  let formatted = phone.trim();
  if (formatted.startsWith('0')) {
    formatted = '254' + formatted.substring(1);
  } else if (formatted.startsWith('+')) {
    formatted = formatted.substring(1);
  }
  
  if (!formatted.startsWith('254')) {
    throw new Error('Phone number must start with 254');
  }
  
  if (formatted.length !== 12) {
    throw new Error('Phone number must be 12 digits (254XXXXXXXXX)');
  }
  
  return formatted;
}

function validateAmount(amount) {
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Amount must be a positive number');
  }
  return numAmount;
}

// In-memory transaction storage (for demo - use database in production)
let transactions = [];

// Serve Frontend Pages
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
    const response = await axios.get('https://backend.payhero.co.ke/api/transaction_fees');
    
    res.json({
      success: true,
      service: 'BERA TECH Payment Platform',
      status: 'operational',
      timestamp: new Date().toISOString(),
      account_id: process.env.CHANNEL_ID,
      payhero_status: 'connected',
      version: '1.0.0'
    });
  } catch (error) {
    res.json({
      success: false,
      service: 'BERA TECH Payment Platform',
      status: 'degraded',
      error: 'PayHero connection failed',
      timestamp: new Date().toISOString()
    });
  }
});

// 2. STK Push (C2B)
app.post('/api/stk-push', async (req, res) => {
  try {
    const { phone_number, amount, external_reference, customer_name, description } = req.body;

    // Validation
    if (!phone_number || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and amount are required'
      });
    }

    // Format inputs
    const formattedPhone = formatPhoneNumber(phone_number);
    const validatedAmount = validateAmount(amount);
    
    const payload = {
      amount: validatedAmount,
      phone_number: formattedPhone,
      channel_id: process.env.CHANNEL_ID,
      provider: process.env.DEFAULT_PROVIDER || 'm-pesa',
      external_reference: external_reference || `BERA-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      customer_name: customer_name || 'Customer',
      description: description || 'Payment to BERA TECH'
    };

    console.log('🔵 STK Push Request:', payload);

    // Make request to PayHero
    const response = await payheroClient.post('/payments', payload);
    
    // Store transaction
    const transaction = {
      id: payload.external_reference,
      type: 'C2B',
      status: 'QUEUED',
      amount: validatedAmount,
      phone: formattedPhone,
      customer_name: payload.customer_name,
      timestamp: new Date().toISOString(),
      payhero_reference: response.data?.reference || null,
      raw_response: response.data
    };
    
    transactions.unshift(transaction); // Add to beginning of array

    res.json({
      success: true,
      message: 'STK push initiated successfully',
      data: {
        reference: transaction.id,
        status: 'QUEUED',
        instruction: 'Check your phone for M-Pesa prompt',
        transaction
      }
    });

  } catch (error) {
    console.error('❌ STK Push Error:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to initiate STK push'
    });
  }
});

// 3. Transaction Status
app.get('/api/transaction-status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        error: 'Transaction reference is required'
      });
    }

    console.log('🔵 Checking transaction status:', reference);
    
    // Check in PayHero
    const response = await payheroClient.get(`/payments/${reference}/status`);
    
    // Update local transaction if found
    const transactionIndex = transactions.findIndex(t => t.id === reference);
    if (transactionIndex !== -1) {
      transactions[transactionIndex].status = response.data.status;
      transactions[transactionIndex].last_checked = new Date().toISOString();
      transactions[transactionIndex].raw_response = response.data;
    }

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error('❌ Status Check Error:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to get transaction status'
    });
  }
});

// 4. Wallet Withdrawal (B2C)
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

    // Format inputs
    const formattedPhone = formatPhoneNumber(phone_number);
    const validatedAmount = validateAmount(amount);
    
    const payload = {
      amount: validatedAmount,
      phone_number: formattedPhone,
      network_code: network_code,
      channel: 'mobile',
      channel_id: process.env.CHANNEL_ID,
      payment_service: 'b2c',
      description: description || 'Payout from BERA TECH',
      external_reference: `WDR-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
    };

    console.log('🔵 Withdrawal Request:', payload);

    // Make request to PayHero
    const response = await payheroClient.post('/withdraw', payload);
    
    // Store transaction
    const transaction = {
      id: payload.external_reference,
      type: 'B2C',
      status: 'PROCESSING',
      amount: validatedAmount,
      phone: formattedPhone,
      network: network_code === '63902' ? 'M-Pesa' : 'Airtel',
      description: payload.description,
      timestamp: new Date().toISOString(),
      payhero_reference: response.data?.reference || null,
      raw_response: response.data
    };
    
    transactions.unshift(transaction);

    res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      data: {
        reference: transaction.id,
        status: 'PROCESSING',
        estimated_time: '2-10 minutes',
        transaction
      }
    });

  } catch (error) {
    console.error('❌ Withdrawal Error:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to initiate withdrawal'
    });
  }
});

// 5. Transaction Fees
app.get('/api/transaction-fees', async (req, res) => {
  try {
    const { amount } = req.query;
    
    const response = await axios.get('https://backend.payhero.co.ke/api/transaction_fees');
    
    let calculatedFees = null;
    if (amount) {
      const amountNum = parseFloat(amount);
      // Example fee calculation (adjust based on PayHero's actual fee structure)
      const fee = Math.max(1, amountNum * 0.015); // 1.5% or minimum 1 KES
      calculatedFees = {
        amount: amountNum,
        fee: fee,
        total: amountNum + fee,
        breakdown: [
          { name: 'Transaction Amount', amount: amountNum },
          { name: 'Processing Fee (1.5%)', amount: fee }
        ]
      };
    }

    res.json({
      success: true,
      data: {
        fee_schedule: response.data,
        calculated: calculatedFees
      }
    });

  } catch (error) {
    console.error('❌ Fees Error:', error.message);
    
    res.json({
      success: false,
      error: 'Could not fetch fee schedule',
      calculated: {
        amount: parseFloat(amount) || 0,
        fee: 0,
        total: parseFloat(amount) || 0,
        breakdown: []
      }
    });
  }
});

// 6. Get All Transactions (for admin)
app.get('/api/transactions', (req, res) => {
  const { type, limit = 100 } = req.query;
  
  let filteredTransactions = transactions;
  
  if (type && ['C2B', 'B2C'].includes(type)) {
    filteredTransactions = transactions.filter(t => t.type === type);
  }
  
  // Calculate statistics
  const stats = {
    total: transactions.length,
    c2b: transactions.filter(t => t.type === 'C2B').length,
    b2c: transactions.filter(t => t.type === 'B2C').length,
    successful: transactions.filter(t => t.status === 'SUCCESS').length,
    failed: transactions.filter(t => t.status === 'FAILED').length,
    pending: transactions.filter(t => ['QUEUED', 'PROCESSING'].includes(t.status)).length,
    total_amount: transactions.reduce((sum, t) => sum + (t.amount || 0), 0)
  };

  res.json({
    success: true,
    data: {
      transactions: filteredTransactions.slice(0, parseInt(limit)),
      statistics: stats,
      timestamp: new Date().toISOString()
    }
  });
});

// 7. Global Payments Discovery (Optional)
app.get('/api/global/discovery', async (req, res) => {
  try {
    const { country = 'KE' } = req.query;
    
    const response = await axios.get(
      `https://backend.payhero.co.ke/api/global/discovery/payment-world/?country=${country}`,
      {
        headers: {
          'Authorization': process.env.GLOBAL_PAYMENTS_TOKEN
        }
      }
    );
    
    res.json({
      success: true,
      data: response.data
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Global payments not configured or failed',
      note: 'Set GLOBAL_PAYMENTS_TOKEN in .env to enable'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err);
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
  console.log('🚀 BERA TECH Payment Platform');
  console.log('===============================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔑 Account ID: ${process.env.CHANNEL_ID}`);
  console.log(`📱 Provider: ${process.env.DEFAULT_PROVIDER || 'm-pesa'}`);
  console.log('📊 Services:');
  console.log('   • STK Push (C2B)');
  console.log('   • Wallet Withdrawals (B2C)');
  console.log('   • Transaction Status');
  console.log('   • Fee Calculation');
  console.log(`🌐 Frontend: http://localhost:${PORT}`);
  console.log(`🔧 Admin: http://localhost:${PORT}/admin`);
  console.log(`❤️  Health: http://localhost:${PORT}/api/health`);
});
