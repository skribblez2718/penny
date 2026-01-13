# Compression Techniques

## Writing Strategies for Context Reduction

Apply these techniques to compress verbose content while preserving essential information.

---

## 1. Decision-Focused Writing

Focus on WHAT was decided, not HOW the decision was made.

**Before:**
> We conducted extensive research into authentication methods, examining OAuth2, SAML, and JWT approaches. After analyzing security implications, developer experience, and ecosystem maturity, we concluded that OAuth2 with Google provider would be most suitable.

**After:**
> Selected OAuth2/Google (vs SAML, JWT) for superior DX, security, and ecosystem support.

**Compression Ratio:** 95% reduction (41 words to 12 words)

---

## 2. List Consolidation

Convert verbose lists into single-line summaries with key attributes.

**Before:**
- Researched authentication libraries
- Evaluated security implications
- Assessed developer experience
- Reviewed documentation quality
- Tested integration complexity
- Compared performance characteristics

**After:**
> Auth library selection: passport.js (security, DX, docs, integration ease)

**Compression Ratio:** 70% reduction (30 words to 9 words)

---

## 3. Abbreviation Standardization

Use consistent abbreviations to reduce token count.

| Full Term | Abbreviation |
|-----------|--------------|
| Application Programming Interface | API |
| Create Read Update Delete | CRUD |
| Test-Driven Development | TDD |
| JSON Web Token | JWT |
| Representational State Transfer | REST |
| Open Web Application Security Project | OWASP |
| Database | DB |
| User Interface/Experience | UI/UX |
| Authentication | Auth |
| Continuous Integration/Deployment | CI/CD |
| Configuration | Config |
| Implementation | Impl |
| Development | Dev |
| Production | Prod |
| Repository | Repo |

---

## 4. Reference Over Repetition

Point back to earlier decisions instead of restating them.

**Before:**
> The authentication system uses JWT tokens as described in Phase 1. The API design incorporates JWT authentication as outlined in Phase 2. The implementation follows the JWT approach selected earlier.

**After:**
> Auth implementation per Phase 1 JWT decision.

**Compression Ratio:** 80% reduction (35 words to 7 words)

---

## 5. Quantified Summaries

Replace vague descriptions with specific counts and actions.

**Before:**
> We identified several security vulnerabilities including SQL injection risks, XSS attack vectors, and CSRF weaknesses. Each was addressed through appropriate mitigation strategies.

**After:**
> Fixed 3 security issues: SQL injection (parameterized queries), XSS (sanitization), CSRF (tokens).

**Compression Ratio:** 70% reduction (27 words to 15 words)

---

## 6. Action-Outcome Format

Structure compressed content as action + outcome.

**Before:**
> After careful analysis of the user requirements and considering the technical constraints, we decided to implement a modular architecture that separates concerns into distinct layers. This approach will improve maintainability and testability.

**After:**
> Modular architecture selected: improved maintainability/testability.

**Compression Ratio:** 85% reduction

---

## Application Guidelines

### When Compressing Phase Outputs

1. **Extract decisions** - What was chosen and why (briefly)
2. **Remove process** - Delete how the decision was reached
3. **Quantify findings** - Use numbers instead of vague terms
4. **Reference prior work** - Point to earlier phases, don't repeat
5. **Use abbreviations** - Standard terms only

### Token Budget Targets

| Section | Target Tokens |
|---------|---------------|
| Phase summary | 100-150 |
| Key decisions | 150-200 |
| Discoveries | 150-200 |
| Unknowns | 100-150 |
| **Total per phase** | **500-700** |

### Quality Check

After compression, verify:
- [ ] Decisions are preserved with rationale
- [ ] No critical context lost
- [ ] Abbreviations are standard
- [ ] Token budget met
- [ ] Downstream phases have needed context
