import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response
from sqlmodel import Session

from .database import get_session
from .models import AuthSession, User, utcnow

COOKIE_NAME = "jagaai_v3_session"


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
    return session.get(User, auth.user_id)


def authenticated(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    return user


def staff(user: User = Depends(authenticated)) -> User:
    if user.role not in {"admin", "supervisor"}:
        raise HTTPException(403, "Management access is required.")
    return user


def admin(user: User = Depends(staff)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Administrator access is required.")
    return user


def resident(user: User = Depends(authenticated)) -> User:
    if user.role != "resident":
        raise HTTPException(403, "A resident account is required.")
    return user


def user_json(user: User) -> dict:
    return {field: getattr(user, field) for field in ("id", "email", "name", "role")}


def establish_session(response: Response, session: Session, user: User):
    token = secrets.token_urlsafe(40)
    session.add(AuthSession(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user.id, expires_at=utcnow() + timedelta(hours=12)))
    session.commit()
    response.set_cookie(COOKIE_NAME, token, max_age=43200, httponly=True, samesite="strict", path="/")
