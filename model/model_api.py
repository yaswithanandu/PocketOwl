from flask import Flask, request, jsonify
from flask_cors import CORS
import psycopg2
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
from datetime import datetime
import calendar
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64
import numpy as np



app = Flask(__name__)
CORS(app, origins=["http://localhost:3000"], supports_credentials=True)

def get_db_connection():
    db_configs = [
        {'host': '192.168.100.39', 'port': '26257', 'user': 'root', 'password': '', 'dbname': 'exptracker1', 'sslmode': 'disable'},
        {'host': '192.168.100.195', 'port': '26257', 'user': 'root', 'password': '', 'dbname': 'exptracker1', 'sslmode': 'disable'}
    ]
    for config in db_configs:
        try:
            return psycopg2.connect(**config)
        except psycopg2.Error:
            continue
    return None

@app.route('/api/analyze', methods=['POST'])
def analyze():
    data = request.json
    user_id = data.get('user_id')
    month = data.get('month')

    if not user_id or not month:
        return jsonify({'error': 'Missing user_id or month'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'error': 'DB connection failed'}), 500

    cursor = conn.cursor()

    # Fetch total expenditure & transaction count for the month
    cursor.execute("""
        SELECT SUM(amount), COUNT(*)
        FROM Expenditures
        WHERE user_id = %s AND EXTRACT(MONTH FROM date) = %s;
    """, (user_id, month))
    total_spent, num_transactions = cursor.fetchone()
    total_spent = float(total_spent) if total_spent else 0
    num_transactions = num_transactions or 0

    # Fetch budget for this month
    cursor.execute("""
        SELECT COALESCE(SUM(total_budget), 0)
        FROM Budgets
        WHERE user_id = %s AND EXTRACT(MONTH FROM month) = %s;
    """, (user_id, month))
    total_budget = cursor.fetchone()[0]
    total_budget = float(total_budget) if total_budget else 0

    # If no transactions found, return early
    if num_transactions == 0:
        conn.close()
        return jsonify({
            'error': 'No transactions found for the selected month',
            'summary': {
                'total_spent': 0,
                'num_transactions': 0,
                'top_category': 'N/A',
                'top_category_spent': 0
            }
        }), 200

    # Prepare DataFrame for clustering
    df = pd.DataFrame([{
        'user_id': user_id,
        'total_spent': total_spent,
        'num_transactions': num_transactions,
        'total_budget': total_budget
    }])

    # Clustering
    try:
        scaler = StandardScaler()
        # Fetch more users for better clustering (minimum 3)
        cursor.execute("""
            SELECT e.user_id, SUM(e.amount), COUNT(*), COALESCE(SUM(b.total_budget), 0)
            FROM Expenditures e
            LEFT JOIN Budgets b ON e.user_id = b.user_id
            GROUP BY e.user_id
            LIMIT 10;
        """)
        cluster_data = cursor.fetchall()
        
        if len(cluster_data) < 3:
            # If not enough real users, create synthetic data points for clustering
            synthetic_data = [
                [999, total_spent * 0.7, num_transactions - 2, total_budget * 1.2],
                [998, total_spent * 1.5, num_transactions + 2, total_budget * 0.8]
            ]
            cluster_data.extend(synthetic_data)
            
        cluster_df = pd.DataFrame(cluster_data, columns=['user_id', 'total_spent', 'num_transactions', 'total_budget'])
        cluster_features = cluster_df[['total_spent', 'num_transactions', 'total_budget']]
        
        # Scale features for clustering
        df_scaled = scaler.fit_transform(cluster_features)
        kmeans = KMeans(n_clusters=3, n_init=10, random_state=42)
        cluster_df['cluster'] = kmeans.fit_predict(df_scaled)
        
        # Get cluster for our user
        user_cluster = cluster_df[cluster_df['user_id'] == user_id]['cluster'].iloc[0] if user_id in cluster_df['user_id'].values else 0
    except Exception as e:
        print(f"Clustering error: {e}")
        user_cluster = 0  # Default to low-risk cluster

    # Get top spending category
    cursor.execute("""
        SELECT category, SUM(amount) as total
        FROM Expenditures
        WHERE user_id = %s AND EXTRACT(MONTH FROM date) = %s
        GROUP BY category
        ORDER BY total DESC
        LIMIT 1;
    """, (user_id, month))
    top_category = cursor.fetchone()
    top_category_name = top_category[0] if top_category else "N/A"
    top_category_spent = float(top_category[1]) if top_category else 0

    # Get all categories for the pie chart
    cursor.execute("""
        SELECT category, SUM(amount) as total
        FROM Expenditures
        WHERE user_id = %s AND EXTRACT(MONTH FROM date) = %s
        GROUP BY category
        ORDER BY total DESC;
    """, (user_id, month))
    
    categories_data = cursor.fetchall()
    categories = [cat[0] for cat in categories_data]
    category_amounts = [float(cat[1]) for cat in categories_data]
    
    # Generate recommendations based on the cluster
    recommendations = {
        0: "✅ You're managing your expenses well. Keep it up!",
        1: "⚠️ You're close to your budget limit. Stay cautious.",
        2: "❌ You're overspending. Consider cutting back on unnecessary expenses."
    }
    
    recommendation = recommendations.get(user_cluster, "No specific recommendation available.")
    if user_cluster == 2 and top_category_name != "N/A":
        recommendation += f" High spending on {top_category_name}."

    # Daily spending plan
    today = datetime.today()
    last_day = calendar.monthrange(today.year, today.month)[1]
    days_left = last_day - today.day

    if days_left <= 0:
        daily_plan = "⚠️ The month is ending. Plan for the next month."
    else:
        remaining = total_budget - total_spent
        if remaining > 0:
            daily_plan = f"✅ To stay within budget, limit daily spending to ₹{(remaining / days_left):.2f}."
        else:
            daily_plan = "❌ You've already exceeded your budget."

    # Generate charts
    # 1. Pie chart for expense distribution by category
    plt.figure(figsize=(8, 8))
    plt.pie(category_amounts, labels=categories, autopct='%1.1f%%', startangle=140, 
            colors=['#ff9999','#66b3ff','#99ff99','#ffcc99', '#c2c2f0', '#ffb3e6', '#ffcc99'])
    plt.title(f'Expense Distribution for User {user_id} - {calendar.month_name[month]}')
    
    # Save pie chart to a base64 string
    pie_buffer = io.BytesIO()
    plt.savefig(pie_buffer, format='png')
    pie_buffer.seek(0)
    pie_chart_base64 = base64.b64encode(pie_buffer.read()).decode('utf-8')
    plt.close()
    
    # Bar chart: Only for selected month
    cursor.execute("""
        SELECT EXTRACT(DAY FROM date) as day, SUM(amount) as total
        FROM Expenditures
        WHERE user_id = %s AND EXTRACT(MONTH FROM date) = %s
        GROUP BY EXTRACT(DAY FROM date)
        ORDER BY day;
    """, (user_id, month))

    daily_data = cursor.fetchall()
    days = [int(d[0]) for d in daily_data]
    daily_amounts = [float(d[1]) for d in daily_data]

    plt.figure(figsize=(10, 5))
    plt.bar(days, daily_amounts, color='mediumseagreen')
    plt.axhline(y=(total_budget / calendar.monthrange(datetime.today().year, month)[1]), 
                color='red', linestyle='--', label='Avg Daily Budget')
    plt.xlabel('Day of Month')
    plt.ylabel('Amount (₹)')
    plt.title(f'Daily Expenses for User {user_id} - {calendar.month_name[month]}')
    plt.legend()

    # Save updated bar chart to base64
    bar_buffer = io.BytesIO()
    plt.savefig(bar_buffer, format='png')
    bar_buffer.seek(0)
    bar_chart_base64 = base64.b64encode(bar_buffer.read()).decode('utf-8')
    plt.close()

    
    conn.close()

    return jsonify({
        "summary": {
            "total_spent": round(total_spent, 2),
            "total_budget": round(total_budget, 2),
            "budget_remaining": round(total_budget - total_spent, 2),
            "num_transactions": num_transactions,
            "top_category": top_category_name,
            "top_category_spent": round(top_category_spent, 2)
        },
        "charts": {
            "pie_chart": f"data:image/png;base64,{pie_chart_base64}",
            "bar_chart": f"data:image/png;base64,{bar_chart_base64}"
        },
        "recommendation": recommendation,
        "daily_plan": daily_plan
    })

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)