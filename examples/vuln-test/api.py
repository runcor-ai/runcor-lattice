# api.py — user lookup endpoint.

from flask import Flask, request, jsonify
import sqlite3

app = Flask(__name__)

@app.route('/users')
def get_user():
    user_id = request.args.get('id')
    conn = sqlite3.connect('users.db')
    # SQL injection: user_id interpolated directly into query.
    query = f"SELECT name, email FROM users WHERE id = {user_id}"
    cur = conn.execute(query)
    row = cur.fetchone()
    return jsonify({'name': row[0], 'email': row[1]})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')  # debug=True in prod, listening on all interfaces.
