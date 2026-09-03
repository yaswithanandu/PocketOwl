import express from 'express';
import bodyParser from 'body-parser';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import session from 'express-session';
import { exec } from 'child_process'; // Add this missing import

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
var port = 3000;

const { Pool, types } = pkg;
//To parse and save me from BigINT JS corruption broo jesus
types.setTypeParser(20, val => val);

//DB
const pool = new Pool({
    user: 'root',
    host: '192.168.180.195',
    database: 'exptracker1',
    port: 26257,
    ssl: false
});

//Testing the connection with the DB
pool.query('SELECT NOW()', (error, result) => {
  if (error) {
    console.error('Database connection error:', error.stack);
  } else {
    console.log('Connected to CockroachDB at', result.rows[0].now);
  }
});

//Middleware
app.use(express.json()); //Parses incoming json 
app.use(bodyParser.urlencoded({extended: true})); //Takes data from forms g
app.use(express.static(__dirname + '/public')); // Serve static files

//Create a session man
app.use(session({
    secret: 'keep-it-safe', //Long string
    resave: false,
    saveUninitialized: false
}));


//Landing page
app.get('/', (req,res) => {
    res.sendFile(__dirname + '/public/landing-page.html');
})

app.get('/login', (req,res) => {
    res.sendFile(__dirname + '/public/login.html');
});

//Login details
app.post('/login', async (req, res) => {
    const { email, password: passwrd} = req.body;
    try{
        const userQuery = await pool.query('SELECT user_id,email,password_hash from USERS where email=$1', [email]);
        
        if(userQuery.rows.length > 0){
            //User exists
            const user = userQuery.rows[0];
            if(user.email === email && user.password_hash === passwrd){
                req.session.userId = user.user_id; //Storing the userID in the session! 
                res.redirect('/dashboard');
            }else{
                //Goes back to login page
                res.redirect('/login');
            }
        }else{
            res.send("No user found! Please Register in the DB");
        }
    }catch(error){
        console.error('Error during login!', error);
        res.status(500).send("Internal Server Error mostly lmao!");
    }
});

//Handle add expenses (SAVE Button press -> Need to check)
app.post('/api/transactions', async (req, res) => {
    const userId = req.session.userId;
    if(!userId){
        console.log("Error, Not logged in!");
        res.status(401).json({ error: "Not logged in!"});
    }

    const transactionData = req.body;
    
    try{
        //Updated transaction with userId
        const updatedTransactionData = {
            userId,
            ...transactionData
        }
        
        if(updatedTransactionData.type === 'expense'){
            //Insert into DB
            const query = `
            INSERT INTO expenditures (user_id, amount, category, description, date)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
            `;

            const { userId: usr_id, amount, date, category, description } = updatedTransactionData;
            const values = [ usr_id, amount, category, description, date];

            const result = await pool.query(query, values)
            return res.status(201).json({ message: "EXPENSE added!", data: result.rows[0] });
        }else if(updatedTransactionData.type === 'income'){
            const query = `
            INSERT INTO budgets (user_id, total_budget, month)
            VALUES ($1, $2, $3)
            RETURNING *;
            `;
            
            const { userId: usr_id, amount , date } = updatedTransactionData;
            const values = [ usr_id, amount, date ];

            const result = await pool.query(query, values)
            return res.status(201).json({ message: "Income added!", data: result.rows[0] });
        }
        
    }catch(error){
        console.error("Error: ", error);
        return res.status(500).json({ error: "Internal server error while adding transaction" });
    }
});

app.get('/dashboard', (req, res) => {
    if(!req.session.userId){
        res.redirect('/login'); //Go to login page man!
    }
    res.sendFile(__dirname + '/public/modified-dashboard.html');
});

//Delete Request -> NEED TWO FOR expenses and incomes
app.delete('/api/expenses/:id', (req,res) => {
    const userId = req.session.userId;
    const { id } = req.params;

    if(!userId){
        return res.status(401).json({ error: 'Not logged in lil bro!' });
    }

    const query = `
    DELETE FROM expenditures 
    WHERE expense_id = $1 AND user_id = $2
    RETURNING *;
    `;

    const values = [id, userId];
    
    pool.query(query, values)
        .then( result => {
            if(result.rowCount == 0){
                return res.status(404).json({ error: 'Transaction not found or not authorised to perform this request! '});
            }

            res.json({ message: 'Transaction Deleted!', data: result.rows[0] });
        })
        .catch( error => {
            console.error('Error deleting transaction: ', error);
            res.status(500).json({ error: 'Internal server error or DB error' });
        });
});

app.delete('/api/incomes/:id', (req, res) => {
    const userId = req.session.userId;
    const { id } = req.params;

    if(!userId){
        return res.status(401).json({ error: 'Not logged in lil bro!' });
    }

    const query = `
    DELETE FROM budgets
    WHERE budget_id = $1 AND user_id = $2
    RETURNING *;
    `;

    const values = [id, userId];
    
    pool.query(query, values)
        .then( result => {
            if(result.rowCount == 0){
                return res.status(404).json({ error: 'Transaction not found or not authorised to perform this request! '});
            }

            res.json({ message: 'Transaction Deleted!', data: result.rows[0] });
        })
        .catch( error => {
            console.error('Error deleting transaction: ', error);
            res.status(500).json({ error: 'Internal server error or DB error' });
        });
});

app.get('/api/transactions', async (req, res) => {
    const userId = req.session.userId;
  
    if (!userId) {
      return res.status(401).json({ error: 'Not logged in lil bro!' });
    }
  
    const { month, year } = req.query;
  
    //Used AS Clause in SQL to make life easier in frontend for rename aliases!
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

//edit the transaction query!
app.put('/api/editTransac', async (req, res) => {
    const userId = req.session.userId;

    if(!userId){
        return res.status(401).json({ error: "Not logged in lil mans!" });
    }

    const data = req.body;

    try{
        if(data.type === 'income'){
            //Strip data for income
            const { amount, date, id } = data;

            const query = `
            UPDATE budgets
            SET total_budget = $1, month = $2
            WHERE budget_id = $3::BIGINT AND user_id = $4;
            `;
            
            const values = [amount, date, id, userId];
            
            //Query to DB to update
            await pool.query(query, values);
        }else{
            //type === 'expense'
            //Strip data for expense
            const { amount, date , category, description, id } = data;
            
            const query = `
            UPDATE expenditures
            SET amount = $1, category = $2, description = $3
            WHERE expense_id = $4::BIGINT AND user_id = $5;
            `;
            const values = [amount, category, description, id ,userId];

            //Query to DB to update
            await pool.query(query, values);
        }
        return res.status(200).json({ message: "Transaction updated!" });

    }catch(error){
        console.error("Internal Server or DB Error my guy -->", error);
        return res.status(500).json({ error: "Something went wrong in the backend 😭" });
    }
});

//Time for the analyser
app.get('/analyser', (req, res) => {
    const userId = req.session.userId;
    
    if(!userId){
        console.log("Login First quick man!");
        return res.redirect("/login");
    }else{
        res.sendFile(__dirname + '/public/analyser-page.html');
    }
});

// Connect to Flask API for analysis instead of directly executing Python script
app.post('/api/analyze', async (req, res) => {
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not logged in!' });
    }
    
    const { month } = req.body;
    
    try {
        // Make a request to your Flask API
        const response = await fetch('http://localhost:5001/api/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                user_id: userId, 
                month: parseInt(month) 
            })
        });
        
        if (!response.ok) {
            throw new Error(`Flask API returned ${response.status}`);
        }
        
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

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});