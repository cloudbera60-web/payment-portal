require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate Environment Variables
const requiredEnvVars = ['PAYHERO_AUTH_TOKEN', 'CHANNEL_ID'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

// Middleware
app.use(cors());
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

const payheroClient = axios.create(PAYHERO_CONFIG);

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
    throw new Error('Invalid phone number length. Use 254XXXXXXXXX format');
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
  return numAmount; // Return as number, not string
}

// Store transactions
const transactions = new Map();

// Serve Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'BERA TECH Payment Gateway',
    status: 'operational',
    timestamp: new Date().toISOString(),
    account_id: process.env.CHANNEL_ID,
    version: '1.0.0'
  });
});

// STK Push (C2B) - FIXED: amount as number
app.post('/api/stk-push', async (req, res) => {
  try {
    console.log('📱 Received STK request:', req.body);
    
    const { phone_number, amount, external_reference, customer_name } = req.body;

    // Validate required fields
    if (!phone_number || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and amount are required'
      });
    }

    // Format and validate inputs
    const formattedPhone = formatPhoneNumber(phone_number);
    const validatedAmount = validateAmount(amount); // This returns a number
    
    const reference = external_reference || `BERA${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // PayHero API Payload - amount as NUMBER
    const payload = {
      amount: validatedAmount, // NUMBER, not string
      phone_number: formattedPhone,
      channel_id: process.env.CHANNEL_ID,
      provider: process.env.DEFAULT_PROVIDER || 'm-pesa',
      external_reference: reference,
      customer_name: customer_name || 'Customer',
      description: 'Payment to BERA TECH'
    };

    console.log('📤 Sending to PayHero:', payload);

    try {
      // Make request to PayHero
      const response = await payheroClient.post('/payments', payload);
      console.log('✅ PayHero Response:', response.data);
      
      // Store transaction
      const transaction = {
        id: reference,
        type: 'C2B',
        status: 'PENDING',
        amount: validatedAmount,
        phone: formattedPhone,
        customer_name: payload.customer_name,
        timestamp: new Date().toISOString(),
        payhero_response: response.data
      };
      
      transactions.set(reference, transaction);

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
      
    } catch (payheroError) {
      console.error('❌ PayHero API Error:', payheroError.response?.data || payheroError.message);
      
      let errorMessage = 'Failed to initiate payment';
      if (payheroError.response?.data?.error_message) {
        errorMessage = payheroError.response.data.error_message;
      } else if (payheroError.response?.data?.message) {
        errorMessage = payheroError.response.data.message;
      }
      
      res.status(payheroError.response?.status || 500).json({
        success: false,
        error: errorMessage,
        details: payheroError.response?.data || null
      });
    }

  } catch (error) {
    console.error('❌ STK Push Error:', error.message);
    
    res.status(400).json({
      success: false,
      error: error.message || 'Invalid request data'
    });
  }
});

// Transaction Status - FIXED
app.get('/api/transaction-status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        error: 'Transaction reference is required'
      });
    }

    console.log('🔍 Checking status for:', reference);

    try {
      // Check with PayHero API
      const response = await payheroClient.get(`/payments/${reference}/status`);
      console.log('✅ Status Response:', response.data);
      
      // Update local transaction
      const transaction = transactions.get(reference);
      if (transaction) {
        transaction.status = response.data.status || 'UNKNOWN';
        transaction.last_checked = new Date().toISOString();
        transaction.payhero_response = response.data;
      }

      res.json({
        success: true,
        data: {
          reference: reference,
          status: response.data.status || 'UNKNOWN',
          amount: response.data.amount,
          phone_number: response.data.phone_number,
          description: response.data.description,
          timestamp: response.data.timestamp || new Date().toISOString()
        }
      });
      
    } catch (payheroError) {
      console.error('❌ PayHero Status Error:', payheroError.response?.data || payheroError.message);
      
      // Check local transaction if PayHero fails
      const transaction = transactions.get(reference);
      if (transaction) {
        return res.json({
          success: true,
          data: {
            reference: reference,
            status: transaction.status || 'UNKNOWN',
            amount: transaction.amount,
            phone_number: transaction.phone,
            timestamp: transaction.timestamp,
            note: 'From local cache'
          }
        });
      }
      
      res.status(payheroError.response?.status || 500).json({
        success: false,
        error: payheroError.response?.data?.message || 'Failed to check status'
      });
    }

  } catch (error) {
    console.error('❌ Status Check Error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// Withdrawal (B2C) - FIXED: amount as number
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
    const validNetworks = ['63902', '63903'];
    if (!validNetworks.includes(network_code)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid network code. Use 63902 for M-Pesa or 63903 for Airtel'
      });
    }

    // Format and validate inputs
    const formattedPhone = formatPhoneNumber(phone_number);
    const validatedAmount = validateAmount(amount); // Number
    
    const reference = `WDR${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // PayHero API Payload
    const payload = {
      amount: validatedAmount, // NUMBER
      phone_number: formattedPhone,
      network_code: network_code,
      channel: 'mobile',
      channel_id: process.env.CHANNEL_ID,
      payment_service: 'b2c',
      description: description || 'Withdrawal from BERA TECH',
      external_reference: reference
    };

    console.log('📤 Sending withdrawal to PayHero:', payload);

    try {
      const response = await payheroClient.post('/withdraw', payload);
      console.log('✅ Withdrawal Response:', response.data);
      
      // Store transaction
      const transaction = {
        id: reference,
        type: 'B2C',
        status: 'PROCESSING',
        amount: validatedAmount,
        phone: formattedPhone,
        network: network_code === '63902' ? 'M-Pesa' : 'Airtel',
        description: payload.description,
        timestamp: new Date().toISOString(),
        payhero_response: response.data
      };
      
      transactions.set(reference, transaction);

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
      
    } catch (payheroError) {
      console.error('❌ PayHero Withdrawal Error:', payheroError.response?.data || payheroError.message);
      
      res.status(payheroError.response?.status || 500).json({
        success: false,
        error: payheroError.response?.data?.message || 'Failed to initiate withdrawal'
      });
    }

  } catch (error) {
    console.error('❌ Withdrawal Error:', error.message);
    
    res.status(400).json({
      success: false,
      error: error.message || 'Invalid request data'
    });
  }
});

// Get All Transactions
app.get('/api/transactions', (req, res) => {
  try {
    const transactionList = Array.from(transactions.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 50);
    
    const stats = {
      total: transactions.size,
      c2b: Array.from(transactions.values()).filter(t => t.type === 'C2B').length,
      b2c: Array.from(transactions.values()).filter(t => t.type === 'B2C').length,
      successful: Array.from(transactions.values()).filter(t => t.status === 'SUCCESS').length,
      failed: Array.from(transactions.values()).filter(t => t.status === 'FAILED').length,
      pending: Array.from(transactions.values()).filter(t => ['PENDING', 'PROCESSING'].includes(t.status)).length,
      total_amount: Array.from(transactions.values()).reduce((sum, t) => sum + (t.amount || 0), 0)
    };

    res.json({
      success: true,
      data: {
        transactions: transactionList,
        statistics: stats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get Transactions Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve transactions'
    });
  }
});

// Transaction Fees
app.get('/api/transaction-fees', async (req, res) => {
  try {
    const { amount } = req.query;
    
    if (amount) {
      const amountNum = parseFloat(amount);
      if (!isNaN(amountNum) && amountNum > 0) {
        // PayHero fee structure (approximate)
        const fee = Math.max(10, amountNum * 0.015); // 1.5% or min 10 KES
        const calculatedFees = {
          amount: amountNum,
          fee: fee,
          total: amountNum + fee,
          net_receive: amountNum - fee,
          breakdown: [
            { name: 'Transaction Amount', amount: amountNum },
            { name: 'Processing Fee (1.5%)', amount: fee }
          ]
        };
        
        return res.json({
          success: true,
          data: { calculated: calculatedFees }
        });
      }
    }
    
    res.json({
      success: true,
      data: { calculated: null }
    });
    
  } catch (error) {
    console.error('Fee Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate fees'
    });
  }
});

// Clear Transaction (for testing)
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

// Error handling
app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
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
  console.log('🚀 BERA TECH Payment Gateway Started');
  console.log('===============================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔑 Account ID: ${process.env.CHANNEL_ID}`);
  console.log(`📱 Provider: ${process.env.DEFAULT_PROVIDER || 'm-pesa'}`);
  console.log('📊 Services:');
  console.log('   • STK Push (C2B) - REAL PayHero API');
  console.log('   • Wallet Withdrawals (B2C) - REAL PayHero API');
  console.log('   • Transaction Status - REAL PayHero API');
  console.log(`🌐 Frontend: http://localhost:${PORT}`);
  console.log(`🔧 Admin: http://localhost:${PORT}/admin`);
  console.log(`❤️  Health: http://localhost:${PORT}/api/health`);
});
