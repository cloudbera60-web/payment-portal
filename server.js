require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// PayHero Configuration
const PAYHERO_BASE_URL = 'https://api.payhero.co.ke/v1';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || '3342';

// Create axios instance with authentication
const payheroClient = axios.create({
    baseURL: PAYHERO_BASE_URL,
    headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    },
    timeout: 30000
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'bera-tech-secret-key';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

// Store transactions in memory
const transactions = [];

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (username !== 'admin') {
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials'
            });
        }

        const validPassword = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
        if (!validPassword) {
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials'
            });
        }

        const token = jwt.sign(
            { username, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: { username, role: 'admin' }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            error: 'Login failed'
        });
    }
});

// STK Push Endpoint - FIXED IMPLEMENTATION
app.post('/api/stk-push', async (req, res) => {
    try {
        const { phone_number, amount, payment_type, external_reference, customer_name } = req.body;

        // Validation
        if (!phone_number || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Phone number and amount are required'
            });
        }

        // Format phone number
        let formattedPhone = phone_number.toString().trim();
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.substring(1);
        } else if (formattedPhone.startsWith('+')) {
            formattedPhone = formattedPhone.substring(1);
        }

        // Ensure it starts with 254 and is 12 digits
        if (!formattedPhone.startsWith('254') || formattedPhone.length !== 12) {
            return res.status(400).json({
                success: false,
                error: 'Phone number must be in format 2547XXXXXXXX (12 digits)'
            });
        }

        // Generate transaction reference
        const transactionRef = external_reference || 
            `BERA-${payment_type || 'C2B'}-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        // Create STK payload according to PayHero documentation
        const stkPayload = {
            phone_number: formattedPhone,
            amount: parseFloat(amount),
            provider: 'm-pesa',
            channel_id: CHANNEL_ID,
            external_reference: transactionRef,
            customer_name: customer_name || 'Customer',
            description: `Payment - ${transactionRef}`
        };

        console.log('Initiating STK Push:', JSON.stringify(stkPayload, null, 2));

        // Make request to PayHero STK Push endpoint
        const response = await payheroClient.post('/stk/push', stkPayload);
        
        console.log('STK Push Response:', JSON.stringify(response.data, null, 2));

        // Store transaction
        const transaction = {
            id: response.data.transaction_id || `txn_${Date.now()}`,
            reference: transactionRef,
            phone_number: formattedPhone,
            amount: parseFloat(amount),
            payment_type: payment_type || 'C2B',
            customer_name: customer_name || 'Customer',
            status: 'Pending',
            initiated_at: new Date().toISOString(),
            payhero_response: response.data
        };
        
        transactions.push(transaction);

        res.json({
            success: true,
            message: 'STK push initiated successfully',
            data: {
                reference: transactionRef,
                transaction_id: transaction.id,
                status: 'Pending',
                message: 'STK push sent successfully. Check your phone.',
                payhero_response: response.data
            }
        });

    } catch (error) {
        console.error('STK Push Error:', error.response?.data || error.message);
        
        // Enhanced error handling
        let errorMessage = 'Failed to initiate STK push';
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            errorMessage = error.response.data?.message || 
                          error.response.data?.error || 
                          `PayHero API error: ${error.response.status}`;
        } else if (error.request) {
            // The request was made but no response was received
            errorMessage = 'No response from PayHero API';
        } else {
            // Something happened in setting up the request that triggered an Error
            errorMessage = error.message;
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.response?.data
        });
    }
});

// Transaction Status Endpoint
app.get('/api/transaction-status/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        
        if (!reference) {
            return res.status(400).json({
                success: false,
                error: 'Transaction reference is required'
            });
        }

        console.log('Checking transaction status for:', reference);

        // Check in PayHero
        const response = await payheroClient.get(`/transactions/${reference}`);
        
        console.log('Status Response:', JSON.stringify(response.data, null, 2));

        // Update stored transaction
        const transactionIndex = transactions.findIndex(t => t.reference === reference);
        if (transactionIndex !== -1) {
            transactions[transactionIndex].status = response.data.status || 'Completed';
            transactions[transactionIndex].completed_at = new Date().toISOString();
            transactions[transactionIndex].status_response = response.data;
        }

        res.json({
            success: true,
            data: {
                reference,
                status: response.data.status || 'Completed',
                details: response.data,
                checked_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Transaction Status Error:', error.response?.data || error.message);
        
        let errorMessage = 'Failed to get transaction status';
        if (error.response) {
            errorMessage = error.response.data?.message || 
                          error.response.data?.error || 
                          `PayHero API error: ${error.response.status}`;
            
            // If transaction not found in PayHero, check our local storage
            if (error.response.status === 404) {
                const localTransaction = transactions.find(t => t.reference === req.params.reference);
                if (localTransaction) {
                    return res.json({
                        success: true,
                        data: {
                            reference: req.params.reference,
                            status: localTransaction.status || 'Pending',
                            details: localTransaction,
                            checked_at: new Date().toISOString(),
                            note: 'Status from local storage (PayHero record not found)'
                        }
                    });
                }
            }
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.response?.data
        });
    }
});

// Dashboard Data (Admin Only)
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
    try {
        // Get wallet balance from PayHero
        let walletBalance = 'N/A';
        try {
            const balanceResponse = await payheroClient.get('/wallet/balance');
            walletBalance = balanceResponse.data.balance || '0.00';
        } catch (balanceError) {
            console.log('Could not fetch wallet balance:', balanceError.message);
        }
        
        // Calculate metrics from local transactions
        const totalTransactions = transactions.length;
        const successfulTransactions = transactions.filter(t => t.status === 'Completed').length;
        const pendingTransactions = transactions.filter(t => t.status === 'Pending').length;
        const totalVolume = transactions
            .filter(t => t.status === 'Completed')
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);

        res.json({
            success: true,
            data: {
                metrics: {
                    totalTransactions,
                    successfulTransactions,
                    pendingTransactions,
                    successRate: totalTransactions > 0 ? (successfulTransactions / totalTransactions * 100).toFixed(2) : 0,
                    totalVolume: totalVolume.toFixed(2)
                },
                walletBalance,
                recentTransactions: transactions.slice(-10).reverse()
            }
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load dashboard data'
        });
    }
});

// Get Transactions (Admin Only)
app.get('/api/transactions', authenticateToken, (req, res) => {
    try {
        const { 
            page = 1, 
            limit = 20, 
            status, 
            payment_type, 
            phone 
        } = req.query;

        let filteredTransactions = [...transactions];

        // Apply filters
        if (status) {
            filteredTransactions = filteredTransactions.filter(t => t.status === status);
        }
        if (payment_type) {
            filteredTransactions = filteredTransactions.filter(t => t.payment_type === payment_type);
        }
        if (phone) {
            filteredTransactions = filteredTransactions.filter(t => 
                t.phone_number.includes(phone.replace(/\D/g, ''))
            );
        }

        // Sort by date (newest first)
        filteredTransactions.sort((a, b) => new Date(b.initiated_at) - new Date(a.initiated_at));

        // Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;
        const paginatedTransactions = filteredTransactions.slice(startIndex, endIndex);

        res.json({
            success: true,
            data: {
                transactions: paginatedTransactions,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(filteredTransactions.length / limit),
                    totalTransactions: filteredTransactions.length,
                    hasNextPage: endIndex < filteredTransactions.length,
                    hasPrevPage: startIndex > 0
                }
            }
        });

    } catch (error) {
        console.error('Get transactions error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get transactions'
        });
    }
});

// Test PayHero Connection
app.get('/api/test-payhero', async (req, res) => {
    try {
        // Test with a simple request
        const response = await payheroClient.get('/wallet/balance');
        
        res.json({
            success: true,
            message: 'PayHero connection successful',
            data: response.data,
            headers: {
                auth_token_length: AUTH_TOKEN ? AUTH_TOKEN.length : 0,
                channel_id: CHANNEL_ID
            }
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'PayHero connection failed',
            error: error.response?.data || error.message,
            details: {
                auth_token_provided: !!AUTH_TOKEN,
                auth_token_length: AUTH_TOKEN ? AUTH_TOKEN.length : 0,
                channel_id: CHANNEL_ID,
                api_url: PAYHERO_BASE_URL
            }
        });
    }
});

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        // Test PayHero connection
        let payheroStatus = 'Disconnected';
        let balance = 'N/A';
        
        try {
            const response = await payheroClient.get('/wallet/balance', { timeout: 10000 });
            payheroStatus = 'Connected';
            balance = response.data.balance || 'N/A';
        } catch (error) {
            console.log('PayHero health check failed:', error.message);
        }
        
        res.json({
            success: true,
            message: 'BERA TECH Payment Gateway',
            service: {
                name: 'BERA TECH Payment Platform',
                version: '1.0.0',
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            },
            account: {
                id: CHANNEL_ID,
                provider: 'm-pesa'
            },
            connectivity: {
                payhero: payheroStatus,
                wallet_balance: balance
            },
            statistics: {
                total_transactions: transactions.length,
                pending_transactions: transactions.filter(t => t.status === 'Pending').length
            }
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'Health check failed',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Start server
app.listen(port, () => {
    console.log('🚀 BERA TECH Payment Platform');
    console.log('📍 Server running on port:', port);
    console.log('🔑 Channel ID:', CHANNEL_ID);
    console.log('🔐 Auth Token:', AUTH_TOKEN ? '✓ Provided' : '✗ Missing');
    console.log('💳 Provider: m-pesa');
    console.log('📊 Test Connection: http://localhost:' + port + '/api/test-payhero');
    console.log('🔐 Admin: http://localhost:' + port + '/admin');
    console.log('🌐 Public: http://localhost:' + port);
    console.log('❤️  Health: http://localhost:' + port + '/api/health');
});
