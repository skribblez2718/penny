# Authentication Flow Architecture

Complete documentation of the email+OTP authentication flow with dual-layer security (session cookies + JWT).

## Overview

**Auth Method:** Email + 8-digit OTP (One-Time Password)
**Frontend Auth:** Session cookies (httpOnly, secure, sameSite)
**Backend Auth:** JWT in Authorization header
**JWT Storage:** sessionStorage (NOT localStorage for XSS protection)
**Rate Limiting:** 3 OTP attempts per 15-minute window, 5-minute cooldown

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EMAIL + OTP AUTHENTICATION                          │
│                                                                             │
│  FRONTEND (Flask + Lit)              BACKEND (FastAPI)                      │
│  ┌─────────────────────┐             ┌──────────────────────┐              │
│  │ 1. User enters email│────────────>│ 2. POST /auth/login  │              │
│  │    (auth-login.js)  │   Email     │    - Validate email  │              │
│  │                     │             │    - Generate OTP    │              │
│  └─────────────────────┘             │    - Send email      │              │
│                                      │    - Store OTP record│              │
│                                      └──────────┬───────────┘              │
│                                                  │                          │
│                                                  ▼                          │
│                                      ┌──────────────────────┐              │
│                                      │ OTP Record Created:  │              │
│                                      │ - email              │              │
│                                      │ - code (8 digits)    │              │
│                                      │ - attempts: 0        │              │
│                                      │ - expires_at: +5min  │              │
│                                      └──────────┬───────────┘              │
│                                                  │                          │
│  ┌─────────────────────┐             ┌──────────▼───────────┐              │
│  │ 3. User receives    │             │ 4. Email sent via    │              │
│  │    email with OTP   │<────────────│    email service     │              │
│  └─────────────────────┘             └──────────────────────┘              │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────────┐             ┌──────────────────────┐              │
│  │ 5. User enters OTP  │────────────>│ 6. POST /auth/verify │              │
│  │    (auth-verify.js) │   OTP       │    - Check attempts  │              │
│  │                     │             │    - Validate OTP    │              │
│  └─────────────────────┘             │    - Check expiry    │              │
│                                      │    - Apply rate limit│              │
│                                      └──────────┬───────────┘              │
│                                                  │                          │
│                              ┌──────────────────┴───────────────────┐      │
│                              │                                      │      │
│                              ▼ Success                              ▼ Fail │
│                  ┌──────────────────────┐             ┌──────────────────┐ │
│                  │ 7. Generate:         │             │ Increment attempts│ │
│                  │    - JWT token       │             │ If attempts >= 3:│ │
│                  │    - Session ID      │             │   Set cooldown   │ │
│                  │ Create session record│             │ Return error     │ │
│                  └──────────┬───────────┘             └──────────────────┘ │
│                              │                                              │
│                              ▼                                              │
│  ┌─────────────────────┐   ┌────────────────────┐                          │
│  │ 8. Receive response │<──│ Response:           │                          │
│  │    - session cookie │   │  - Set-Cookie: sid  │                          │
│  │    - JWT in body    │   │    (httpOnly,       │                          │
│  │                     │   │     secure,         │                          │
│  │                     │   │     sameSite)       │                          │
│  └─────────┬───────────┘   │  - { token: JWT }   │                          │
│            │               └─────────────────────┘                          │
│            ▼                                                                 │
│  ┌─────────────────────┐                                                    │
│  │ 9. Store JWT in     │                                                    │
│  │    sessionStorage   │                                                    │
│  │    (NOT localStorage│                                                    │
│  │    for security)    │                                                    │
│  └─────────┬───────────┘                                                    │
│            │                                                                 │
│            ▼                                                                 │
│  ┌─────────────────────┐             ┌──────────────────────┐              │
│  │ 10. Subsequent API  │────────────>│ 11. Validate:        │              │
│  │     requests:       │   + Cookie  │     - Session cookie │              │
│  │     - Cookie: sid   │   + Header  │     - JWT signature  │              │
│  │     - Authorization:│             │     - JWT expiry     │              │
│  │       Bearer <JWT>  │             │     Both required!   │              │
│  └─────────────────────┘             └──────────┬───────────┘              │
│                                                  │                          │
│                              ┌──────────────────┴───────────────────┐      │
│                              ▼ Valid                                ▼ Invalid│
│                  ┌──────────────────────┐             ┌──────────────────┐ │
│                  │ Request proceeds to  │             │ Return 401       │ │
│                  │ endpoint handler     │             │ Unauthorized     │ │
│                  └──────────────────────┘             └──────────────────┘ │
│                                                                             │
│  LOGOUT FLOW:                                                               │
│  ┌─────────────────────┐             ┌──────────────────────┐              │
│  │ 12. POST /auth/     │────────────>│ 13. Invalidate:      │              │
│  │     logout          │             │     - Session record │              │
│  │                     │             │     - Add JWT to     │              │
│  └─────────┬───────────┘             │       blacklist      │              │
│            │                         └──────────┬───────────┘              │
│            ▼                                    │                          │
│  ┌─────────────────────┐             ┌─────────▼────────────┐              │
│  │ 14. Clear:          │<────────────│ Response:            │              │
│  │     - sessionStorage│             │   Clear-Cookie: sid  │              │
│  │     - Redirect to   │             └──────────────────────┘              │
│  │       login         │                                                    │
│  └─────────────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Detailed Flow Steps

### Step 1-2: Email Submission

**Frontend (auth-login.js Lit Component):**
```javascript
async submitEmail(email) {
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });

  if (response.ok) {
    this.showOTPForm();
  } else {
    this.showError('Invalid email');
  }
}
```

**Backend (FastAPI /auth/login):**
```python
@router.post("/auth/login")
async def login(request: LoginRequest, db: AsyncSession):
    # Validate email format
    if not is_valid_email(request.email):
        raise HTTPException(400, "Invalid email format")

    # Generate 8-digit OTP
    otp_code = generate_otp(length=8)

    # Store OTP record
    otp = OTP(
        email=request.email,
        code=otp_code,
        attempts=0,
        expires_at=datetime.utcnow() + timedelta(minutes=5)
    )
    db.add(otp)
    await db.commit()

    # Send email
    await email_service.send_otp(request.email, otp_code)

    return {"message": "OTP sent to email"}
```

### Step 5-7: OTP Verification

**Frontend (auth-verify.js Lit Component):**
```javascript
async submitOTP(otp) {
  const response = await fetch('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // Important for cookies
    body: JSON.stringify({ email, otp })
  });

  if (response.ok) {
    const { token } = await response.json();
    sessionStorage.setItem('jwt', token);  // Store JWT
    this.redirectToApp();
  } else {
    this.handleOTPError(response);
  }
}
```

**Backend (FastAPI /auth/verify):**
```python
@router.post("/auth/verify")
async def verify(request: VerifyRequest, response: Response, db: AsyncSession):
    # Check rate limiting
    if is_rate_limited(request.email):
        raise HTTPException(429, "Too many attempts. Try again in 5 minutes.")

    # Get OTP record
    otp = await db.execute(
        select(OTP).where(OTP.email == request.email)
    ).scalar_one_or_none()

    if not otp:
        raise HTTPException(404, "No OTP found for this email")

    # Check expiry
    if otp.expires_at < datetime.utcnow():
        raise HTTPException(400, "OTP expired")

    # Check attempts
    if otp.attempts >= 3:
        # Set rate limit cooldown
        set_rate_limit(request.email, duration=300)  # 5 minutes
        raise HTTPException(429, "Max attempts exceeded. Locked for 5 minutes.")

    # Validate OTP
    if otp.code != request.otp:
        otp.attempts += 1
        await db.commit()
        raise HTTPException(400, f"Invalid OTP. {3 - otp.attempts} attempts remaining.")

    # OTP valid - generate JWT and session
    user = await get_or_create_user(request.email, db)

    jwt_token = create_jwt(user.id, expires_in=timedelta(hours=24))
    session_id = create_session(user.id, expires_in=timedelta(days=7))

    # Set session cookie
    response.set_cookie(
        key="sid",
        value=session_id,
        httponly=True,
        secure=True,  # HTTPS only
        samesite="lax",
        max_age=7 * 24 * 60 * 60  # 7 days
    )

    # Delete used OTP
    await db.delete(otp)
    await db.commit()

    return {"token": jwt_token, "user": user.to_dict()}
```

### Step 10-11: Authenticated Request

**Frontend:**
```javascript
async makeAuthenticatedRequest(url) {
  const jwt = sessionStorage.getItem('jwt');

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',  // Include session cookie
    headers: {
      'Authorization': `Bearer ${jwt}`
    }
  });

  if (response.status === 401) {
    // Redirect to login
    this.redirectToLogin();
  }

  return response.json();
}
```

**Backend Middleware:**
```python
async def auth_middleware(request: Request, call_next):
    # Skip auth for public endpoints
    if request.url.path in ["/auth/login", "/auth/verify", "/health"]:
        return await call_next(request)

    # Validate session cookie
    session_id = request.cookies.get("sid")
    if not session_id or not is_valid_session(session_id):
        raise HTTPException(401, "Invalid session")

    # Validate JWT
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(401, "Missing JWT token")

    jwt_token = auth_header.split(" ")[1]
    try:
        payload = verify_jwt(jwt_token)
        request.state.user_id = payload["user_id"]
    except JWTError:
        raise HTTPException(401, "Invalid JWT token")

    # Both session and JWT valid - proceed
    return await call_next(request)
```

### Step 12-14: Logout

**Frontend:**
```javascript
async logout() {
  await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'include'
  });

  sessionStorage.removeItem('jwt');
  this.redirectToLogin();
}
```

**Backend:**
```python
@router.post("/auth/logout")
async def logout(request: Request, response: Response, db: AsyncSession):
    session_id = request.cookies.get("sid")

    # Invalidate session
    if session_id:
        await db.execute(
            delete(Session).where(Session.id == session_id)
        )

    # Add JWT to blacklist (if tracking invalidated JWTs)
    jwt_token = request.headers.get("Authorization", "").split(" ")[1]
    if jwt_token:
        await blacklist_jwt(jwt_token, db)

    await db.commit()

    # Clear cookie
    response.delete_cookie("sid")

    return {"message": "Logged out"}
```

## Rate Limiting Details

### Rate Limit Strategy

**Parameters:**
- **Max Attempts:** 3 OTP verification attempts
- **Window:** 15 minutes (900 seconds)
- **Cooldown:** 5 minutes (300 seconds) after exceeding limit

**Implementation:**
```python
# In-memory or Redis-based rate limiter
rate_limits = {}  # {email: {attempts: int, window_start: datetime, locked_until: datetime}}

def is_rate_limited(email: str) -> bool:
    if email not in rate_limits:
        return False

    limit_info = rate_limits[email]

    # Check if locked
    if limit_info.get("locked_until"):
        if datetime.utcnow() < limit_info["locked_until"]:
            return True
        else:
            # Cooldown expired, reset
            del rate_limits[email]
            return False

    # Check window
    window_start = limit_info.get("window_start")
    if datetime.utcnow() - window_start > timedelta(minutes=15):
        # Window expired, reset
        del rate_limits[email]
        return False

    return False

def set_rate_limit(email: str, duration: int):
    rate_limits[email] = {
        "locked_until": datetime.utcnow() + timedelta(seconds=duration)
    }
```

## Security Considerations

### Why Dual-Layer (Session + JWT)?

1. **Session Cookies (httpOnly):**
   - Protects against XSS attacks
   - Browser automatically includes in requests
   - Cannot be accessed by JavaScript

2. **JWT in Headers:**
   - Can be sent to mobile apps or third-party clients
   - Explicit API authentication
   - Can include custom claims

3. **Both Required:**
   - Defense in depth
   - If one is compromised, the other provides protection
   - Reduces risk of session hijacking and XSS

### Why sessionStorage not localStorage?

**sessionStorage:**
- Cleared when tab/window closes
- Not shared across tabs
- Reduces persistence of tokens

**localStorage:**
- Persists across sessions
- Shared across tabs
- Higher risk if XSS vulnerability exists

### Session Cookie Flags

```python
response.set_cookie(
    key="sid",
    value=session_id,
    httponly=True,      # Prevents JavaScript access
    secure=True,        # HTTPS only
    samesite="lax",     # CSRF protection
    max_age=604800      # 7 days
)
```

### JWT Best Practices

- **Algorithm:** Use HS256 (HMAC) or RS256 (RSA) for signing
- **Expiry:** Set reasonable expiration (e.g., 24 hours)
- **Claims:** Include only necessary data (user_id, issued_at, expires_at)
- **Secret:** Store signing key in environment variables
- **Rotation:** Support key rotation for long-lived systems

## Error Scenarios

| Scenario | Frontend Handling | Backend Response |
|----------|-------------------|------------------|
| Invalid email format | Show inline error | 400 Bad Request |
| Wrong OTP (attempts < 3) | Show attempts remaining | 400 Bad Request + attempts count |
| Wrong OTP (attempts = 3) | Show lockout message | 429 Too Many Requests |
| Expired OTP | Show "OTP expired, request new" | 400 Bad Request |
| Rate limited | Show cooldown timer | 429 Too Many Requests |
| Invalid session cookie | Redirect to login | 401 Unauthorized |
| Invalid JWT | Redirect to login | 401 Unauthorized |
| Expired JWT | Refresh or re-login | 401 Unauthorized |

## Database Schema

### Users Table
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### OTPs Table
```sql
CREATE TABLE otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    code CHAR(8) NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_otps_email ON otps(email);
CREATE INDEX idx_otps_expires_at ON otps(expires_at);
```

### Sessions Table
```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
```

## Testing Checklist

- [ ] Email validation works (valid/invalid formats)
- [ ] OTP generation is cryptographically secure
- [ ] OTP expires after 5 minutes
- [ ] Max 3 OTP attempts enforced
- [ ] Rate limiting enforces 5-minute cooldown
- [ ] Session cookie set with correct flags (httpOnly, secure, sameSite)
- [ ] JWT issued on successful OTP verification
- [ ] Both session and JWT required for protected endpoints
- [ ] Logout invalidates session and JWT
- [ ] sessionStorage cleared on logout
- [ ] Redirect to login on 401 responses
