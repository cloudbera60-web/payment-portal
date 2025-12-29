require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PayHeroClient } = require('payhero-devkit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Initialize PayHero Client
const client = new PayHeroClient({
    authToken: process.env.AUTH_TOKEN
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'bera-tech-secret-key';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

// Store transactions in memory (in production use a database)
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

// STK Push Endpoint
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
        let formattedPhone = phone_number.trim();
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.substring(1);
        } else if (formattedPhone.startsWith('+')) {
            formattedPhone = formattedPhone.substring(1);
        }

        if (!formattedPhone.startsWith('254') || formattedPhone.length !== 12) {
            return res.status(400).json({
                success: false,
                error: 'Phone number must be in format 2547XXXXXXXX'
            });
        }

        // Generate transaction reference
        const transactionRef = external_reference || 
            `BERA-${payment_type || 'C2B'}-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        // Create STK payload
        const stkPayload = {
            phone_number: formattedPhone,
            amount: parseFloat(amount),
            provider: process.env.DEFAULT_PROVIDER || 'm-pesa',
            channel_id: process.env.CHANNEL_ID,
            external_reference: transactionRef,
            customer_name: customer_name || 'Customer',
            description: `BERA TECH Payment - ${transactionRef}`
        };

        console.log('Initiating STK Push:', { ...stkPayload, amount: `${amount} KES` });
        
        const response = await client.stkPush(stkPayload);
        
        console.log('STK Push Response:', response);
        
        // Store transaction
        const transaction = {
            id: response.transaction_id || `txn_${Date.now()}`,
            reference: transactionRef,
            phone_number: formattedPhone,
            amount: parseFloat(amount),
            payment_type: payment_type || 'C2B',
            customer_name: customer_name || 'Customer',
            status: 'Pending',
            initiated_at: new Date().toISOString(),
            response: response
        };
        
        transactions.push(transaction);
        
        // Keep only last 1000 transactions
        if (transactions.length > 1000) {
            transactions.shift();
        }

        res.json({
            success: true,
            message: 'STK push initiated successfully',
            data: {
                reference: transactionRef,
                transaction_id: transaction.id,
                status: 'Pending',
                message: 'Check your phone for M-Pesa prompt',
                timestamp: transaction.initiated_at
            }
        });

    } catch (error) {
        console.error('STK Push Error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to initiate STK push'
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

        console.log('Checking transaction status:', reference);
        const response = await client.transactionStatus(reference);
        
        // Update stored transaction status
        const transactionIndex = transactions.findIndex(t => t.reference === reference);
        if (transactionIndex !== -1) {
            transactions[transactionIndex].status = response.status || 'Completed';
            transactions[transactionIndex].completed_at = new Date().toISOString();
            transactions[transactionIndex].status_response = response;
        }

        res.json({
            success: true,
            data: {
                reference,
                status: response.status || 'Completed',
                details: response,
                checked_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Transaction Status Error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to get transaction status'
        });
    }
});

// Dashboard Data (Admin Only)
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
    try {
        // Get wallet balance from PayHero
        const balance = await client.serviceWalletBalance();
        
        // Calculate metrics
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
                walletBalance: balance,
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

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        const balance = await client.serviceWalletBalance();
        
        res.json({
            success: true,
            message: 'BERA TECH Payment Gateway is operational',
            service: {
                name: 'BERA TECH Payment Platform',
                version: '1.0.0'
            },
            account: {
                id: process.env.CHANNEL_ID,
                provider: process.env.DEFAULT_PROVIDER || 'm-pesa'
            },
            connectivity: {
                payhero: 'Connected',
                wallet_balance: balance
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'Gateway running but PayHero connection failed',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Start server
app.listen(port, () => {
    console.log('🚀 BERA TECH Payment Platform');
    console.log('📍 Server running on port:', port);
    console.log('🏢 Account ID:', process.env.CHANNEL_ID);
    console.log('💳 Provider:', process.env.DEFAULT_PROVIDER || 'm-pesa');
    console.log('🔐 Admin: http://localhost:' + port + '/admin');
    console.log('🌐 Public: http://localhost:' + port);
    console.log('❤️  Health: http://localhost:' + port + '/api/health');
});
