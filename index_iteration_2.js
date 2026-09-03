import express from 'express';
import bodyParser from 'body-parser';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import session from 'express-session';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = 3000;

const { Pool, types } = pkg;
types.setTypeParser(20, val => val);

// ---------- DB FAILOVER LOGIC START ---------- //
const dbHosts = ['192.168.180.39', '192.168.180.195'];
const dbConfigTemplate = {
    user: 'root',
    database: 'exptracker1',
    port: 26257,
    ssl: false
};

let pool = null;

async function connectToDatabase() {
    for (let host of dbHosts) {
        const config = { ...dbConfigTemplate, host };
        let tempPool;
        try {
            tempPool = new Pool(config);

            // Try a simple query to test connection
            await tempPool.query('SELECT NOW()');

            console.log(`✅ Connected to CockroachDB at ${host}`);
            pool = tempPool;
            return;
        } catch (err) {
            console.warn(`⚠️ Failed to connect to ${host}: ${err.message}`);
            if (tempPool) await tempPool.end(); // Clean up pool if failed
        }
    }

    throw new Error('❌ Could not connect to any CockroachDB instance.');
}


// ---------- DB FAILOVER LOGIC END ---------- //


// Middleware
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));

app.use(session({
    secret: 'keep-it-safe',
    resave: false,
    saveUninitialized: false
}));


// Landing page
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/landing-page.html');
});

app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

// Login handler
app.post('/login', async (req, res) => {
    const { email, password: passwrd } = req.body;
    try {
        const userQuery = await pool.query('SELECT user_id, email, password_hash FROM USERS WHERE email=$1', [email]);

        if (userQuery.rows.length > 0) {
            const user = userQuery.rows[0];
            if (user.email === email && user.password_hash === passwrd) {
                req.session.userId = user.user_id;
                res.redirect('/dashboard');
            } else {
                res.redirect('/login');
            }
        } else {
            res.send("No user found! Please Register in the DB");
        }
    } catch (error) {
        console.error('Error during login!', error);
        res.status(500).send("Internal Server Error mostly lmao!");
    }
});

app.post('/api/transactions', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "Not logged in!" });

    const transactionData = req.body;

    try {
        const updatedTransactionData = { userId, ...transactionData };

        if (updatedTransactionData.type === 'expense') {
            const query = `
                INSERT INTO expenditures (user_id, amount, category, description, date)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *;
            `;
            const { userId: usr_id, amount, date, category, description } = updatedTransactionData;
            const values = [usr_id, amount, category, description, date];
            const result = await pool.query(query, values);
            return res.status(201).json({ message: "EXPENSE added!", data: result.rows[0] });
        } else if (updatedTransactionData.type === 'income') {
            const query = `
                INSERT INTO budgets (user_id, total_budget, month)
                VALUES ($1, $2, $3)
                RETURNING *;
            `;
            const { userId: usr_id, amount, date } = updatedTransactionData;
            const values = [usr_id, amount, date];
            const result = await pool.query(query, values);
            return res.status(201).json({ message: "Income added!", data: result.rows[0] });
        }
    } catch (error) {
        console.error("Error: ", error);
        return res.status(500).json({ error: "Internal server error while adding transaction" });
    }
});

app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(__dirname + '/public/modified-dashboard.html');
});

app.delete('/api/expenses/:id', (req, res) => {
    const userId = req.session.userId;
    const { id } = req.params;
    if (!userId) return res.status(401).json({ error: 'Not logged in lil bro!' });

    const query = `
        DELETE FROM expenditures 
        WHERE expense_id = $1 AND user_id = $2
        RETURNING *;
    `;

    pool.query(query, [id, userId])
        .then(result => {
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Transaction not found or not authorised!' });
            }
            res.json({ message: 'Transaction Deleted!', data: result.rows[0] });
        })
        .catch(error => {
            console.error('Error deleting transaction: ', error);
            res.status(500).json({ error: 'Internal server error or DB error' });
        });
});

app.delete('/api/incomes/:id', (req, res) => {
    const userId = req.session.userId;
    const { id } = req.params;
    if (!userId) return res.status(401).json({ error: 'Not logged in lil bro!' });

    const query = `
        DELETE FROM budgets
        WHERE budget_id = $1 AND user_id = $2
        RETURNING *;
    `;

    pool.query(query, [id, userId])
        .then(result => {
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Transaction not found or not authorised!' });
            }
            res.json({ message: 'Transaction Deleted!', data: result.rows[0] });
        })
        .catch(error => {
            console.error('Error deleting transaction: ', error);
            res.status(500).json({ error: 'Internal server error or DB error' });
        });
});

app.get('/api/transactions', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not logged in lil bro!' });

    const { month, year } = req.query;

    try {
        const expensesQuery = `
            SELECT 
                CAST(expense_id AS TEXT) AS id,
                amount, 
                category, 
                description,
                date, 
                'expense' AS type
            FROM expenditures                                                                                                                     
            WHERE user_id = $1                                                                                                                   
                AND EXTRACT(MONTH FROM date) = $2                                                                                                        
                AND EXTRACT(YEAR FROM date) = $3;
        `;

        const incomeQuery = `
            SELECT
                CAST(budget_id AS TEXT) AS id,
                total_budget AS amount,
                month AS date, 
                'income' AS type
            FROM budgets                                                                                                                    
            WHERE user_id = $1                                                                                                                       
                AND EXTRACT(MONTH FROM month) = $2                                                                                                       
                AND EXTRACT(YEAR FROM month) = $3;
        `;

        const [expensesRes, incomeRes] = await Promise.all([
            pool.query(expensesQuery, [userId, month, year]),
            pool.query(incomeQuery, [userId, month, year])
        ]);

        const allTransactions = [...expensesRes.rows, ...incomeRes.rows];
        res.json({ message: 'Fetched all transactions', data: allTransactions });

    } catch (err) {
        console.error('Error in loading transactions : ', err);
        res.status(500).json({ error: "Internal server error lil bro!" });
    }
});

app.put('/api/editTransac', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "Not logged in lil mans!" });

    const data = req.body;

    try {
        if (data.type === 'income') {
            const { amount, date, id } = data;
            const query = `
                UPDATE budgets
                SET total_budget = $1, month = $2
                WHERE budget_id = $3::BIGINT AND user_id = $4;
            `;
            const values = [amount, date, id, userId];
            await pool.query(query, values);
        } else {
            const { amount, date, category, description, id } = data;
            const query = `
                UPDATE expenditures
                SET amount = $1, category = $2, description = $3
                WHERE expense_id = $4::BIGINT AND user_id = $5;
            `;
            const values = [amount, category, description, id, userId];
            await pool.query(query, values);
        }
        return res.status(200).json({ message: "Transaction updated!" });

    } catch (error) {
        console.error("Internal Server or DB Error my guy -->", error);
        return res.status(500).json({ error: "Something went wrong in the backend 😭" });
    }
});

app.get('/analyser', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect("/login");
    res.sendFile(__dirname + '/public/analyser-page.html');
});

app.post('/api/analyze', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not logged in!' });

    const { month } = req.body;

    try {
        const response = await fetch('http://localhost:5001/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, month: parseInt(month) })
        });

        if (!response.ok) throw new Error(`Flask API returned ${response.status}`);

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error calling Flask API:', error);
        res.status(500).json({
            error: 'Failed to analyze expenses. Is the Python analysis server running?',
            message: error.message
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Bootstrapping server
connectToDatabase()
    .then(() => {
        app.listen(port, () => {
            console.log(`🚀 Server is running on port ${port}`);
        });
    })
    .catch((err) => {
        console.error('❌ Server startup failed due to DB issues:', err.message);
        process.exit(1);
    });
