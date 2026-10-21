import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response
from sqlmodel import Session, select

from .database import get_session
from .models import AuthSession, User, utcnow

COOKIE_NAME = "jagaai_v3_session"
ROLES = ("resident", "guard", "manager", "admin")
# Everyone who uses the security workstation; managers and admins also manage people and the estate.
STAFF_ROLES = {"guard", "manager", "admin"}
MANAGER_ROLES = {"manager", "admin"}


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 260000).hex()
    return f"pbkdf2_sha256$260000${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def current_user(request: Request, session: Session = Depends(get_session)) -> User | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    auth = session.get(AuthSession, hashlib.sha256(token.encode()).hexdigest())
    if not auth or aware(auth.expires_at) <= utcnow():
        return None
    user = session.get(User, auth.user_id)
    # A disabled or unapproved account loses access at once, even with a valid cookie.
    return user if user and user.status == "active" else None


def authenticated(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    return user


def staff(user: User = Depends(authenticated)) -> User:
    if user.role not in STAFF_ROLES:
        raise HTTPException(403, "Security workstation access is required.")
    return user


def manager(user: User = Depends(staff)) -> User:
    if user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Management access is required.")
    return user


def admin(user: User = Depends(manager)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Administrator access is required.")
    return user


def resident(user: User = Depends(authenticated)) -> User:
    if user.role != "resident":
        raise HTTPException(403, "A resident account is required.")
    return user


def user_json(user: User) -> dict:
    return {field: getattr(user, field) for field in ("id", "email", "name", "role", "unit")}


def account_json(user: User) -> dict:
    return {**user_json(user), "status": user.status, "phone": user.phone, "created_at": aware(user.created_at).isoformat()}


def revoke_sessions(session: Session, user_id: str):
    for record in session.exec(select(AuthSession).where(AuthSession.user_id == user_id)).all():
        session.delete(record)


def establish_session(response: Response, session: Session, user: User):
    token = secrets.token_urlsafe(40)
    session.add(AuthSession(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user.id, expires_at=utcnow() + timedelta(hours=12)))
    session.commit()
    response.set_cookie(COOKIE_NAME, token, max_age=43200, httponly=True, samesite="strict", path="/",
                        secure=os.environ.get("JAGAAI_SECURE_COOKIE", "0") == "1")
