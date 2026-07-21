"""Password-only session authentication for the analytics dashboard."""

import hmac
import os
from datetime import datetime, timedelta

from flask import jsonify, request, session

if __package__:
    from .server_audit import AUTHENTICATION, WARNING, client_ip, write_server_action
else:
    from server_audit import AUTHENTICATION, WARNING, client_ip, write_server_action


def configure_authentication(app):
    app.secret_key = os.environ.get('DASHBOARD_SESSION_SECRET') or os.urandom(32)
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        SESSION_COOKIE_SECURE=os.environ.get('DASHBOARD_COOKIE_SECURE', '').lower() == 'true',
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12)
    )
    password = os.environ.get('DASHBOARD_PASSWORD', 'jp6vu cl3gj94')
    attempts = {}
    attempt_limit = 5
    attempt_window = timedelta(minutes=1)

    @app.before_request
    def require_dashboard_login():
        if request.path.startswith('/api/') and not request.path.startswith('/api/auth/'):
            if not session.get('dashboard_authenticated'):
                return jsonify({"error": "Authentication required"}), 401

    @app.get('/api/auth/status')
    def auth_status():
        return jsonify({"authenticated": bool(session.get('dashboard_authenticated'))})

    @app.post('/api/auth/login')
    def auth_login():
        supplied_password = str((request.get_json(silent=True) or {}).get('password', ''))
        client_key = request.remote_addr or 'unknown'
        now = datetime.utcnow()
        recent = [value for value in attempts.get(client_key, []) if now - value < attempt_window]
        if len(recent) >= attempt_limit:
            attempts[client_key] = recent
            write_server_action(
                WARNING,
                f"Login rate limited ip={client_ip()}",
            )
            return jsonify({"error": "Too many login attempts. Please wait one minute."}), 429
        if not hmac.compare_digest(supplied_password.encode(), password.encode()):
            attempts[client_key] = recent + [now]
            write_server_action(
                AUTHENTICATION,
                f"Login failed ip={client_ip()}",
            )
            return jsonify({"error": "Invalid password"}), 401
        attempts.pop(client_key, None)
        session.clear()
        session.permanent = True
        session['dashboard_authenticated'] = True
        write_server_action(
            AUTHENTICATION,
            f"Login succeeded ip={client_ip()}",
        )
        return jsonify({"authenticated": True})

    @app.post('/api/auth/logout')
    def auth_logout():
        write_server_action(
            AUTHENTICATION,
            f"Logout ip={client_ip()}",
        )
        session.clear()
        return jsonify({"authenticated": False})
